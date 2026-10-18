/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { TOOL_DEFS, executeTool, writeFile, runCommand } from './tools.js';
import { resolveInside } from './safety.js';
import { clientFor } from './clients.js';
import { parseModelRef } from './cloud.js';
import { Checkpoints } from './git.js';
import { detectChecks, failed } from './checks.js';
import { webTools } from './web.js';
import { classifyTask, parseSteps, parseTasks, PLAN_PROMPT } from './router.js';
import { updateIndex, retrieve, formatHits, loadIndex, indexDir, makeEmbedder } from './indexer.js';
import os from 'node:os';
import { OllamaClient, oomAdvice, waitForServer, ensureServer, ollamaBinary } from './ollama.js';
import { runTeam, planWaves, helperUI } from './team.js';
import { formatPlan } from './tools.js';
import { parseToolCalls, findJsonObjects, parseLenient } from './parser.js';
import { extractCodeFiles, wantsFiles, hasUnsavedCode, fileNamesIn } from './rescue.js';
import { dlog } from './debug.js';
import { systemPrompt, DISTILL_PROMPT, CONSOLIDATE_PROMPT, COMMIT_PROMPT } from './prompt.js';
import { detectStatedPreferences, makeNote, mergeNotes } from './memory.js';
import { detectRepoStyle } from './style.js';
import { c } from './ui.js';

/** Streams text to the terminal but hides anything that looks like a JSON tool call. */
class StreamFilter {
  constructor(write) { this.write = write; this.buf = ''; this.printed = 0; this.stopped = false; }
  push(tok) {
    this.buf += tok;
    if (this.stopped) return;
    const m = this.buf.slice(this.printed).search(/<tool_call>|```json|```\s*\{|(^|\n)\s*\{\s*"/);
    if (m !== -1) {
      this.write(this.buf.slice(this.printed, this.printed + m));
      this.printed += m;
      this.stopped = true;
      return;
    }
    // Only hold back text when the tail could be the start of a tool-call marker.
    const tail = this.buf.slice(Math.max(this.printed, this.buf.length - 12));
    const k = tail.search(/[{<`]/);
    const safe = k === -1 ? this.buf.length : this.buf.length - (tail.length - k);
    if (safe > this.printed) { this.write(this.buf.slice(this.printed, safe)); this.printed = safe; }
  }
  end() {
    if (this.stopped) return; // held-back text stays available through hidden()
    if (this.printed < this.buf.length) this.write(this.buf.slice(this.printed));
    this.printed = this.buf.length;
  }
  /** Text held back because it looked like a tool call (shown if it turns out not to be one). */
  hidden() { return this.stopped ? this.buf.slice(this.printed) : ''; }
}

export const READ_ONLY_TOOLS = ['list_dir', 'read_file', 'search'];

export class Agent {
  constructor({ cfg, root, ui, client, memory, extraTools = [] }) {
    this.cfg = cfg;
    this.root = root;
    this.ui = ui;
    this.memory = memory;
    this.messages = [];
    this.mode = 'agent'; // 'agent' or 'explain'
    this.extraTools = extraTools; // plugins etc: { def, run(ctx,args), approval?(args) }
    this.native = null; // null = unknown, true = native tools, false = JSON fallback
    if (client) { this.client = client; this.modelName = parseModelRef(cfg.model, cfg)?.model || cfg.model; this.cloud = !!client.isCloud; this.setFast(); }
    else this.setModel(cfg.model);
    this.checkpoints = cfg.git?.checkpoints === false ? { enabled: false, list: [] } : new Checkpoints(root);
    this.ctx = {
      root, ui, cfg, memory, backups: [], plan: [],
      always: { writes: false, commands: new Set(), tools: new Set() },
      session: { events: [], writes: new Map(), said: [] }
    };
    this.ctx.pluginApi = {
      root,
      resolve: (p) => resolveInside(root, p),
      readFile: (p) => fs.readFileSync(resolveInside(root, p), 'utf8'),
      writeFile: (p, content) => writeFile(this.ctx, { path: p, content }),
      exec: (command) => runCommand(this.ctx, { command }),
      print: (t) => ui.print(String(t)),
      cfg
    };
  }

  get model() { return this.modelName; }

  /** Switch model: plain names are Ollama models, "cloud:..." uses an OpenAI-compatible API. */
  setModel(ref) {
    const r = clientFor(ref, this.cfg);
    this.client = r.client;
    this.modelName = r.model;
    this.cloud = r.cloud;
    this.cfg.model = ref;
    this.native = null;
    this.setFast();
    return r;
  }

  /** The small "fast" model for quick jobs (never a cloud model). */
  setFast() {
    const f = this.cfg.fastModel;
    this.fast = null;
    if (f && f !== this.cfg.model && !String(f).startsWith('cloud:')) {
      const r = clientFor(f, this.cfg);
      this.fast = { client: r.client, model: r.model, native: null };
    }
  }

  /** Which { client, model } handles a kind of job: 'explain' | 'commit' | 'memory' | 'plan' | 'code'. */
  modelFor(kind) {
    if (this.fast && this.cfg.router?.[kind] === 'fast') return this.fast;
    return { client: this.client, model: this.modelName, native: this.native };
  }

  clients() { return [this.client, this.fast?.client].filter(Boolean); }

  /** Models of about 4B parameters or less get a stricter, shorter prompt and extra help with tool calls. */
  isSmall() {
    if (this.cfg.smallModel === true || this.cfg.smallModel === false) return this.cfg.smallModel;
    return modelSizeB(this.model, this._paramSize) <= 4;
  }

  async init() {
    const caps = await this.client.supportsTools(this.model);
    this._paramSize = this.client.paramSize?.(this.model) || null;
    const mode = this.cfg.toolMode || 'auto'; // 'auto' | 'native' | 'text'
    this.native = mode === 'text' ? false : mode === 'native' ? true : caps !== false;
    dlog('init', { model: this.model, capsTools: caps, paramSize: this._paramSize, toolMode: mode, native: this.native, small: this.isSmall(), fast: this.fast?.model || null, root: this.root });
    if (this.fast) {
      const ok = await this.fast.client.hasModel(this.fast.model).catch(() => false);
      if (!ok) this.fast = null;
      else this.fast.native = (await this.fast.client.supportsTools(this.fast.model)) !== false;
    }
    try { this.emberMd = fs.readFileSync(path.join(this.root, 'EMBER.md'), 'utf8'); } catch { this.emberMd = ''; }
    if (this.memory?.enabled) {
      try { this.memory.detected = detectRepoStyle(this.root); } catch { this.memory.detected = []; }
    }
    if (this.cfg.web?.enabled && !this.extraTools.some((t) => t.def.function.name === 'web_search')) this.extraTools.push(...webTools());
    await this.initIndex();
  }

  // ---------- project index ----------

  embedder() {
    const ic = this.cfg.index || {};
    if (!ic.embeddings || !ic.embedModel) return null;
    return makeEmbedder(new OllamaClient(this.cfg.host, { keepAlive: this.cfg.keepAlive }), ic.embedModel);
  }

  /** Incrementally update the index at session start (cheap), building it for small projects. */
  async initIndex({ force = false } = {}) {
    this.index = null;
    const ic = this.cfg.index || {};
    if (ic.enabled === false) return null;
    try {
      const exists = fs.existsSync(path.join(indexDir(this.root), 'index.json'));
      if (!exists && !force) {
        const { listFiles } = await import('./indexer.js');
        const n = listFiles(this.root, (ic.autoMaxFiles ?? 3000) + 1).length;
        if (!n || n > (ic.autoMaxFiles ?? 3000)) return null;
      }
      // Embeddings at session start only refresh an existing vector store (built by `ember index`),
      // so a first session in a big repo never stalls on embedding everything.
      // Low-memory mode skips loading a second (embedding) model at session start.
      let emb = force || (ic.sessionEmbeddings !== false && fs.existsSync(path.join(indexDir(this.root), 'vectors.json'))) ? this.embedder() : null;
      if (emb && !(await emb.client.hasModel(emb.model, { timeoutMs: 1500 }).catch(() => false))) emb = null;
      this._embedder = emb;
      this.indexStats = await updateIndex(this.root, emb ? { embed: emb.embed, embedModel: emb.model } : {});
      this.index = loadIndex(this.root);
      if (!this.extraTools.some((t) => t.def.function.name === 'find_code')) {
        this.extraTools.push({
          def: { type: 'function', function: { name: 'find_code', description: 'Find the files/symbols most related to a description (project index).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
          approval: null,
          run: async (_ctx, a) => formatHits(await this.findCode(String(a.query || ''), 8), 1500) || 'No matches in the index.'
        });
      }
    } catch (e) { this.index = null; this.indexError = e.message; }
    return this.indexStats;
  }

  async findCode(query, k = this.cfg.index?.hints ?? 6) {
    if (!this.index) return [];
    return retrieve(this.root, query, { k, index: this.index, embedQuery: this._embedder?.embedQuery });
  }

  /** Add "likely relevant files" to a user message (not the system prompt, to keep it cache-stable). */
  async withHints(text) {
    if (!this.index || text.length < 8) return text;
    try {
      const hits = (await this.findCode(text)).filter((h) => h.score >= 1);
      if (!hits.length) return text;
      return `${text}\n\n(Ember project index: files that look relevant to this message. Read them if needed; they are only hints, not instructions.)\n${formatHits(hits)}`;
    } catch { return text; }
  }

  clear() { this.messages = []; this.ctx.plan = []; }

  /** Tool definitions available in the current mode. */
  toolDefs() {
    const base = this.mode === 'explain' ? TOOL_DEFS.filter((t) => READ_ONLY_TOOLS.includes(t.function.name)) : TOOL_DEFS;
    const extra = this.extraTools.filter((t) => this.mode !== 'explain' || !t.approval || t.def.function.name.startsWith('web_'));
    return [...base, ...extra.map((t) => t.def)];
  }

  toolNames() { return this.toolDefs().map((t) => t.function.name); }

  system(query) {
    // Keep the system prompt byte-identical across turns so Ollama can reuse its prompt cache.
    // Memory is selected for the first request and refreshed only when memory actually changes.
    const memVersion = this.memory ? `${this.memory.profile.notes.length}:${this.memory.project.length}:${this.memory.profile.updated}` : '';
    if (this._memVersion !== memVersion || this._memText === undefined) {
      this._memVersion = memVersion;
      this._memText = this.memory?.forPrompt(query) || '';
    }
    return systemPrompt({
      root: this.root, tools: this.toolDefs(), fallback: !this.native, explain: this.mode === 'explain',
      emberMd: this.emberMd, memory: this._memText, small: this.isSmall()
    });
  }

  trimContext() {
    // Rewriting history invalidates Ollama's prompt cache, so trim rarely but deeply:
    // only once over budget, and then down to ~60% of it.
    const budget = (this.cfg.numCtx || 8192) * 3; // ~chars
    let total = this.messages.reduce((n, m) => n + (m.content?.length || 0), 0);
    if (total <= budget) return;
    const target = budget * 0.6;
    for (let i = 0; i < this.messages.length - 4 && total > target; i++) {
      const m = this.messages[i];
      if ((m.role === 'tool' || m._toolResult) && m.content.length > 200) {
        total -= m.content.length - 40;
        m.content = '[older tool output trimmed]';
      }
    }
  }

  async chatOnce(signal, sys) {
    const stopThinking = this.ui.thinking ? this.ui.thinking() : () => {};
    const filter = new StreamFilter((t) => { stopThinking(); this.ui.write(t); });
    const msgs = [{ role: 'system', content: sys }, ...this.messages.map(({ _toolResult, ...m }) => m)];
    const opts = { num_ctx: this.cfg.numCtx, temperature: this.cfg.temperature };
    try {
      dlog('request', { model: this.model, native: !!this.native, small: this.isSmall(), mode: this.mode, tools: this.toolNames(), systemChars: sys.length, messages: msgs.length, lastUser: [...msgs].reverse().find((m) => m.role === 'user')?.content?.slice(0, 4000) });
      const r = await this.client.chat({ model: this.model, messages: msgs, tools: this.native ? this.toolDefs() : undefined, options: opts, onToken: (t) => filter.push(t), signal });
      stopThinking();
      filter.end();
      r.hidden = filter.hidden();
      dlog('reply', { model: this.model, content: r.content, tool_calls: r.tool_calls, stats: r.stats });
      return r;
    } catch (e) {
      stopThinking();
      dlog('error', { model: this.model, message: e.message, unreachable: !!e.unreachable, oom: !!e.oom, status: e.status });
      if (e.unreachable && !this._recovering && !signal?.aborted) {
        if (await this.recoverOllama(e)) {
          this._recovering = true;
          try { return await this.chatOnce(signal, sys); } finally { this._recovering = false; }
        }
        throw friendly(e);
      }
      if (e.oom && !signal?.aborted) {
        const running = this.client.listRunning ? await this.client.listRunning().catch(() => []) : [];
        this.ui.print('');
        this.ui.error(e.message);
        this.ui.print(oomAdvice({ model: this.model, ramGB: Math.round(os.totalmem() / 1024 ** 3), running }));
        throw friendly(e, 'Stopped: the model could not run (see the tips above).');
      }
      if (e.noTools && this.native) {
        this.native = false;
        this.ui.print(c.gray('(model has no native tool calling; using JSON tool mode)'));
        dlog('decision', { what: 'native tools rejected by Ollama, switching to text tool mode' });
        return this.chatOnce(signal, this.system(this.lastQuery));
      }
      throw e;
    }
  }

  /** Ollama is not answering: say so, offer to start it (asks first), then retry with backoff. */
  async recoverOllama(e) {
    const host = e.host || this.cfg.host;
    this.ui.print('');
    this.ui.error(`Can't reach Ollama at ${host}.`);
    if (!this.client.version || this.cloud) return false;
    if (await waitForServer(this.client, { timeoutMs: 1500 })) return true; // it was only restarting
    const bin = ollamaBinary();
    if (!bin) { this.ui.print(`  Ollama isn't installed or isn't on PATH. Install it with ${c.bold('ember setup')}, or start it yourself with ${c.bold('ollama serve')}.`); return false; }
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(host)) { this.ui.print(`  ${host} is not on this computer, so Ember can't start it. Check that server, or use --host.`); return false; }
    const ok = await this.ui.confirm('Start Ollama now (runs `ollama serve` in the background)?', { allowAlways: false });
    if (ok !== 'y') { this.ui.print(`  OK. Start it yourself with ${c.bold('ollama serve')}, then try again.`); return false; }
    this.ui.print(c.gray('  starting Ollama…'));
    if (!(await ensureServer(this.client, { timeoutMs: 30000 }))) { this.ui.error(`Ollama did not start. Try ${c.bold('ollama serve')} in another terminal to see why.`); return false; }
    this.ui.ok('Ollama is running');
    dlog('decision', { what: 'started ollama serve after connection failure' });
    return true;
  }

  /**
   * Small models sometimes save code under the wrong name (todo.json for "write todo.py").
   * Only when the target is a data file whose content isn't that format, and the request
   * names exactly one other file that doesn't exist yet, is the write redirected there.
   */
  fixMisnamedWrite(call, userText) {
    const args = call.arguments || {};
    const p = String(args.path || args.file_path || args.filename || '').replace(/^\.\//, '');
    const content = typeof args.content === 'string' ? args.content : null;
    if (!p || content == null) return;
    const ext = path.extname(p).toLowerCase();
    let wrongFormat = false;
    if (ext === '.json') { try { JSON.parse(content); } catch { wrongFormat = true; } }
    else if (ext === '.txt' || ext === '.md') wrongFormat = /^\s*(import |from \S+ import|def |#!\/|const |function |package |#include)/m.test(content) && !/```/.test(content);
    if (!wrongFormat) return;
    const named = [...new Set(fileNamesIn(userText))].filter((f) => f !== p && path.extname(f).toLowerCase() !== ext);
    if (named.length !== 1 || fs.existsSync(path.join(this.root, named[0])) || fs.existsSync(path.join(this.root, p))) return;
    this.ui.print(c.gray(`  (the model named the file ${p}, but you asked for ${named[0]}; saving it as ${named[0]})`));
    dlog('decision', { what: 'misnamed write redirected', from: p, to: named[0] });
    call.arguments = { ...args, path: named[0] };
    delete call.arguments.file_path; delete call.arguments.filename;
  }

  async execTool(name, args) {
    if (!this.toolNames().includes(name)) throw new Error(`Tool "${name}" is not available${this.mode === 'explain' ? ' in explain mode (read-only)' : ''}. Available: ${this.toolNames().join(', ')}`);
    const extra = this.extraTools.find((t) => t.def.function.name === name);
    if (!extra) return executeTool(this.ctx, name, args);
    if (extra.approval && !this.ctx.always.tools.has(name)) {
      this.ui.print('');
      let ok = await this.ui.confirm(extra.approval(args));
      if (ok === 'a') { this.ctx.always.tools.add(name); ok = 'y'; }
      if (ok !== 'y') { this.ctx.session.events.push({ type: 'rejected', tool: name, detail: JSON.stringify(args).slice(0, 100) }); return `User declined ${name}.`; }
    }
    const out = await extra.run(this.ctx, args);
    return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
  }

  /** Run one user turn through the agent loop. Returns the final assistant text. */
  async run(userText, { signal, hints } = {}) {
    this.lastQuery = userText;
    if (this.memory?.enabled && this.mode === 'agent') {
      for (const p of detectStatedPreferences(userText)) {
        const r = this.memory.remember(p.text, { scope: p.scope, source: 'said' });
        this.ctx.session.said.push(p.text);
        if (r.added) this.ui.print(c.gray(`  (noted${p.scope === 'project' ? ' for this project' : ''}: "${p.text}" · /forget to undo)`));
      }
    }
    this.messages.push({ role: 'user', content: hints === false ? userText : await this.withHints(userText) });
    const seen = new Map();
    let finalText = '';
    let stuck = 0, nudged = false, rescued = false, nudgedSave = false;
    const maxSteps = this.cfg.maxSteps || 25;
    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) throw new Error('aborted');
      this.trimContext();
      const r = await this.chatOnce(signal, this.system(userText));
      const names = this.toolNames();
      const native = (r.tool_calls || []).map((tc, i) => ({ ...tc, id: tc.id || `call_${step}_${i}` }));
      let calls = native.map((tc) => ({ id: tc.id, name: tc.function?.name, arguments: typeof tc.function?.arguments === 'string' ? safeJson(tc.function.arguments) : (tc.function?.arguments || {}) }));
      let viaText = false;
      let text = r.content || '';
      if (!calls.length) {
        const parsed = parseToolCalls(text, names, this.toolDefs());
        if (parsed.calls.length) { calls = parsed.calls; viaText = true; text = parsed.text; }
        dlog('parse', { native: native.length, textCalls: parsed.calls.map((x) => x.name), style: parsed.style, hiddenChars: (r.hidden || '').length });
      } else dlog('parse', { native: calls.map((x) => x.name) });
      // Code pasted into the reply instead of written with write_file (common with small models).
      const writes = calls.some((x) => ['write_file', 'edit_file'].includes(x.name));
      if (this.mode === 'agent' && !writes && !rescued && wantsFiles(userText)) {
        const files = extractCodeFiles(r.content || '', userText).filter((f) => !calls.length || !fs.existsSync(path.join(this.root, f.path)));
        if (files.length) {
          rescued = true;
          if (r.hidden && !calls.length) { this.ui.write(r.hidden); r.hidden = ''; }
          const saved = await this.offerSave(files);
          dlog('decision', { what: 'code in chat → offered save', files: files.map((f) => `${f.path} (${f.reason})`), saved });
          if (!calls.length) {
            this.messages.push({ role: 'assistant', content: r.content || '' });
            if (saved.length) this.messages.push({ role: 'user', content: `(Ember saved the code from your reply to ${saved.join(', ')}. Next time call write_file yourself.)`, _toolResult: true });
            finalText = text;
            if (text && !text.endsWith('\n')) this.ui.write('\n');
            break;
          }
        } else if (!calls.length && !nudgedSave && hasUnsavedCode(r.content || '')) {
          // Code with no file name: ask the model once to save it properly.
          nudgedSave = true;
          if (r.hidden) { this.ui.write(r.hidden); r.hidden = ''; }
          this.ui.print(c.gray('\n  (the model showed code without saving it; asking it to use write_file)'));
          dlog('decision', { what: 'unsaved code without a file name → nudge to call write_file' });
          this.messages.push({ role: 'assistant', content: r.content || '' });
          this.messages.push({ role: 'user', content: `You put code in your reply but did not save it. Save it now: call write_file with "path" (a file name relative to the project) and "content" (the complete file).${this.native ? '' : ' Reply with ONLY the JSON tool call.'}`, _toolResult: true });
          continue;
        }
      }
      if (!calls.length) {
        // A JSON "call" to a tool that doesn't exist (small models do this instead of answering): nudge once.
        const bogus = !nudged && findJsonObjects(text).find((o) => typeof o.value?.name === 'string' && o.value.arguments && !names.includes(o.value.name) && text.replace(/```(json)?/g, '').trim().length <= o.end - o.start + 4);
        if (bogus) {
          nudged = true;
          dlog('decision', { what: 'call to unknown tool → nudge', name: bogus.value.name });
          this.messages.push({ role: 'assistant', content: r.content || '' });
          this.messages.push({ role: 'user', content: `There is no tool named "${bogus.value.name}". Tools: ${names.join(', ')}. If you can answer now, reply to the developer in plain text (don't mention tools).`, _toolResult: true });
          continue;
        }
        // The stream filter hid text that looked like a tool call but wasn't one: show it now.
        if (r.hidden) { this.ui.write(r.hidden); dlog('decision', { what: 'no tool call found; showing held-back text', chars: r.hidden.length }); }
        this.messages.push({ role: 'assistant', content: r.content || '' });
        finalText = text;
        if ((r.hidden || text) && !(r.hidden || text).endsWith('\n')) this.ui.write('\n');
        break;
      }
      if (viaText || !this.native) this.messages.push({ role: 'assistant', content: r.content || '' });
      else this.messages.push({ role: 'assistant', content: r.content || '', tool_calls: native });

      let progressed = false;
      for (const call of calls) {
        const sig = call.name + JSON.stringify(call.arguments);
        seen.set(sig, (seen.get(sig) || 0) + 1);
        let result;
        const planSame = call.name === 'update_plan' && JSON.stringify(call.arguments?.steps) === JSON.stringify(this.ctx.plan);
        if (seen.get(sig) > 2 || planSame) {
          result = planSame
            ? 'Plan unchanged. Do the next pending step now, or if everything is done reply with a short summary and no tool call.'
            : 'You already made this exact call twice. Do something different or finish with a summary.';
        } else {
          progressed = true;
          if (call.name === 'write_file' && this.mode === 'agent') this.fixMisnamedWrite(call, userText);
          if (!['write_file', 'edit_file', 'run_command', 'update_plan', 'remember'].includes(call.name)) {
            this.ui.print(c.gray(`  · ${call.name} ${summarizeArgs(call.arguments)}`));
          }
          try { result = String(await this.execTool(call.name, call.arguments || {})); }
          catch (e) { result = `Error: ${e.message}`; this.ui.print(c.red(`  ✗ ${e.message}`)); }
          dlog('tool', { name: call.name, args: call.arguments, result: result.slice(0, 2000) });
        }
        if (viaText || !this.native) this.messages.push({ role: 'user', content: `Result of ${call.name}:\n${result}`, _toolResult: true });
        else this.messages.push({ role: 'tool', content: result, tool_name: call.name, tool_call_id: call.id });
      }
      stuck = progressed ? 0 : stuck + 1;
      if (stuck >= 2) {
        this.ui.print(c.gray('(the model is repeating itself, so Ember stopped this turn)'));
        break;
      }
      if (step === maxSteps - 1) this.ui.warn('Reached the step limit for this turn. Say "continue" to keep going.');
    }
    return finalText;
  }

  /** Offer to save code blocks from a reply as files (each still shows a diff and asks). */
  async offerSave(files) {
    const saved = [];
    this.ui.print('');
    this.ui.print(c.yellow(`The model wrote code for ${files.map((f) => f.path).join(', ')} in its reply instead of saving it.`));
    for (const f of files) {
      try {
        const abs = path.join(this.root, f.path);
        if (fs.existsSync(abs)) {
          const cur = fs.readFileSync(abs, 'utf8');
          if (f.content.split('\n').length < cur.split('\n').length * 0.5) { this.ui.print(c.gray(`  (not offering ${f.path}: the code is only part of the existing file; ask Ember to edit it instead)`)); continue; }
        }
        const out = await writeFile(this.ctx, { path: f.path, content: f.content }, { question: `Save this code to ${f.path}?` });
        if (/^(Created|Updated)/.test(out)) saved.push(f.path);
      } catch (e) { this.ui.print(c.red(`  ✗ ${f.path}: ${e.message}`)); }
    }
    return saved;
  }

  /** Explain mode: read-only tools, plain-language answer. */
  async explain(question, opts = {}) {
    const prev = { mode: this.mode, client: this.client, model: this.modelName, native: this.native };
    const m = this.modelFor('explain');
    this.mode = 'explain';
    this.client = m.client; this.modelName = m.model; this.native = m.native;
    try { return await this.run(question, opts); }
    finally { this.mode = prev.mode; this.client = prev.client; this.modelName = prev.model; this.native = prev.native; }
  }

  /** Ask the planner for small focused tasks ([{ task, files }]). Returns [] when the job is small. */
  async planTasks(text, { signal } = {}) {
    const m = this.modelFor('plan');
    try {
      const r = await m.client.chat({ model: m.model, messages: [{ role: 'system', content: PLAN_PROMPT }, { role: 'user', content: text }], options: { temperature: 0, num_ctx: this.cfg.numCtx, num_predict: 700 }, signal });
      const tasks = parseTasks(r.content, this.cfg.steps?.maxSteps ?? 6);
      return tasks.length >= 2 ? tasks : [];
    } catch { return []; }
  }

  async planSteps(text, opts) { return (await this.planTasks(text, opts)).map((t) => t.task); }

  /** A helper agent for parallel work: same model, tools, approvals and undo history; its own conversation. */
  spawnHelper(role) {
    const ui = helperUI(this.ui, role);
    const h = new Agent({ cfg: this.cfg, root: this.root, ui, client: this.client, memory: this.memory, extraTools: this.extraTools });
    Object.assign(h, { modelName: this.modelName, native: this.native, fast: this.fast, cloud: this.cloud, emberMd: this.emberMd, index: this.index, _embedder: this._embedder });
    h.checkpoints = { enabled: false, list: [] };
    h.ctx = { ...this.ctx, ui, owner: role, plan: [] };
    return h;
  }

  /** Run a big job as small focused steps with short contexts. */
  async runSteps(text, steps, { signal } = {}) {
    this.ctx.plan = steps.map((step) => ({ step, status: 'pending' }));
    this.ui.print(formatPlan(this.ctx.plan));
    const done = [];
    let last = '';
    const plan = this.ctx.plan;
    const mark = (i, st) => { if (plan[i]) plan[i].status = st; };
    for (let i = 0; i < steps.length; i++) {
      this.ctx.plan = plan; // the model may have replaced the plan with update_plan; keep the step list
      mark(i, 'in_progress');
      this.messages = []; // focused: each step starts from a short context
      const prompt = `Overall goal: ${text}\n${done.length ? `Already done:\n${done.map((d) => `- ${d}`).join('\n')}\n` : ''}Now do ONLY this step (${i + 1}/${steps.length}): ${steps[i]}\nWhen this step is done, reply with one short sentence.`;
      last = await this.run(prompt, { signal });
      this.ctx.plan = plan;
      mark(i, 'done');
      done.push(`${steps[i]}${last ? ` (${last.slice(0, 120)})` : ''}`);
      this.ui.print(c.gray(`  ✔ step ${i + 1}/${steps.length}`));
    }
    // Leave a compact history for follow-up questions.
    this.messages = [{ role: 'user', content: text }, { role: 'assistant', content: `Done:\n${done.map((d) => `- ${d}`).join('\n')}` }];
    return last;
  }

  /**
   * A full task: git checkpoint, agent turn, then the self-fix loop
   * (run the project's checks and let the model fix failures, up to N attempts).
   */
  async runTask(userText, { signal, selfFix = this.cfg.selfFix?.enabled !== false } = {}) {
    if (this.checkpoints.enabled) {
      try {
        this.checkpoints.create(userText.slice(0, 80));
        if (this.checkpoints.list.length === 1) this.ui.print(c.gray('  (git checkpoint saved · /rollback undoes everything Ember did this session)'));
      } catch (e) { this.ui.print(c.gray(`  (could not create a git checkpoint: ${e.message})`)); }
    }
    const before = this.ctx.backups.length;
    let text;
    const tasks = this.cfg.steps?.enabled !== false && classifyTask(userText) === 'big' ? await this.planTasks(userText, { signal }) : [];
    const team = this.cfg.team?.enabled !== false && tasks.length >= 2 && planWaves(tasks, this.cfg.team?.maxParallel ?? 2).some((w) => w.length > 1);
    if (team) text = await runTeam(this, userText, tasks, { signal, selfFix });
    else if (tasks.length) text = await this.runSteps(userText, tasks.map((t) => t.task), { signal });
    else text = await this.run(userText, { signal });
    if (!team && selfFix && this.ctx.backups.length > before) await this.selfFix({ signal });
    if (this.index && this.ctx.backups.length > before) {
      try { await updateIndex(this.root, this._embedder ? { embed: this._embedder.embed, embedModel: this._embedder.model } : {}); this.index = loadIndex(this.root); } catch { /* keep old index */ }
    }
    return text;
  }

  /** Run checks; on failure feed errors back to the model. Returns true when everything passes. */
  async selfFix({ signal, maxAttempts = this.cfg.selfFix?.maxAttempts ?? 3 } = {}) {
    const checks = detectChecks(this.root, this.cfg);
    if (!checks.length) return true;
    for (let attempt = 0; ; attempt++) {
      let failure = null;
      for (const ch of checks) {
        if (signal?.aborted) return false;
        this.ui.print(c.gray(`\n  checking: ${ch.command}`));
        const out = await runCommand(this.ctx, { command: ch.command, timeout_sec: this.cfg.selfFix?.timeoutSec ?? 300 });
        if (/^User (declined|blocked)/.test(out)) { this.ui.print(c.gray('  (skipped checks)')); return false; }
        if (failed(out)) { failure = { ch, out }; break; }
      }
      if (!failure) { this.ui.ok(`Checks pass (${checks.map((x) => x.command).join(', ')})`); return true; }
      if (attempt >= maxAttempts) {
        this.ui.warn(`\`${failure.ch.command}\` still fails after ${maxAttempts} fix attempt(s). Over to you (or say "keep fixing").`);
        return false;
      }
      this.ui.print(c.yellow(`\n  ${failure.ch.command} failed; fixing (attempt ${attempt + 1}/${maxAttempts})…`));
      const tail = failure.out.length > 6000 ? failure.out.slice(-6000) : failure.out;
      await this.run(`The check \`${failure.ch.command}\` failed after your changes (fix attempt ${attempt + 1} of ${maxAttempts}). Output:\n${tail}\n\nFind the root cause and fix it with edit_file/write_file. Do not weaken or delete tests unless they are clearly wrong. Do not run the check yourself; Ember re-runs it.`, { signal });
    }
  }

  /** Ask the model for a commit message for a diff. */
  async commitMessage(diff, { signal } = {}) {
    const m = this.modelFor('commit');
    const r = await m.client.chat({ model: m.model, messages: [{ role: 'system', content: COMMIT_PROMPT }, { role: 'user', content: diff }], options: { temperature: 0.2, num_ctx: this.cfg.numCtx, num_predict: 120 }, signal });
    return r.content;
  }

  // ---------- learning ----------

  collectUserEdits() {
    const edits = [];
    for (const [abs, written] of this.ctx.session.writes) {
      let now;
      try { now = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (now !== written) {
        const r = path.relative(this.root, abs);
        const patch = createTwoFilesPatch(r, r, written, now, 'ember wrote', 'user changed to', { context: 1 });
        edits.push(patch.split('\n').slice(2).join('\n').slice(0, 1500));
      }
    }
    return edits;
  }

  /** Distill durable notes from this session. Safe to call more than once. */
  async learn({ signal, force = false } = {}) {
    if (!this.memory?.enabled || this.cfg.memory?.autoLearn === false) return [];
    const s = this.ctx.session;
    const edits = this.collectUserEdits();
    const userMsgs = this.messages.filter((m) => m.role === 'user' && !m._toolResult).map((m) => m.content.slice(0, 400));
    // Only distill when the session carried a real signal about the user (rejections, undos,
    // edits after Ember, or stated preferences). Plain accepted sessions teach little and
    // tend to produce one-off "task" notes.
    const evidence = s.events.filter((e) => e.type !== 'accepted').length + edits.length + s.said.length;
    if (!userMsgs.length || (!evidence && !force)) return [];
    const log = [
      'Existing notes:', ...this.memory.profile.notes.map((n) => `- ${n.text}`), ...this.memory.project.map((n) => `- (project) ${n.text}`),
      '', 'User requests:', ...userMsgs.map((m) => `- ${m}`),
      '', 'Approvals/rejections:', ...s.events.slice(-30).map((e) => `- ${e.type}: ${e.detail}`),
      ...(edits.length ? ['', 'User edited Ember\'s output afterwards:', ...edits] : [])
    ].join('\n');
    let content;
    try {
      const mm = this.modelFor('memory');
      const r = await mm.client.chat({ model: mm.model, messages: [{ role: 'system', content: DISTILL_PROMPT }, { role: 'user', content: log }], options: { temperature: 0, num_ctx: this.cfg.numCtx }, signal });
      content = r.content;
    } catch { return []; }
    const learned = [];
    for (const o of findJsonObjects(content || '')) {
      if (!Array.isArray(o.value?.notes)) continue;
      for (const n of o.value.notes.slice(0, 5)) {
        const text = typeof n === 'string' ? n : n?.text;
        if (!text || text.length < 6 || text.length > 200) continue;
        // Keep only preference-shaped notes; small models sometimes echo events ("Rolled back 2 files").
        if (!/\b(prefer|prefers|use|uses|avoid|always|never|keep|write|don'?t|do not|likes?|wants?|dislikes?|style|indent|quotes|tests?)\b/i.test(text)) continue;
        const r = this.memory.remember(text, { scope: n?.scope === 'project' ? 'project' : 'global', source: 'learned' });
        if (r.added) learned.push(text);
      }
      break;
    }
    await this.consolidate({ signal });
    return learned;
  }

  /** When learned notes pile up, ask the model to merge them (user-stated notes are kept as-is). */
  async consolidate({ signal, force = false } = {}) {
    const max = this.memory.maxNotes;
    for (const scope of ['global', 'project']) {
      const list = scope === 'global' ? this.memory.profile.notes : this.memory.project;
      const learned = list.filter((n) => n.source === 'learned');
      if (!force && list.length < max * 0.8) continue;
      if (learned.length < 4) continue;
      let content;
      try {
        const mm = this.modelFor('memory');
        const r = await mm.client.chat({ model: mm.model, messages: [{ role: 'system', content: CONSOLIDATE_PROMPT }, { role: 'user', content: learned.map((n) => JSON.stringify({ text: n.text, ts: n.ts })).join('\n') }], options: { temperature: 0, num_ctx: this.cfg.numCtx }, signal });
        content = r.content;
      } catch { continue; }
      const o = findJsonObjects(content || '').find((x) => Array.isArray(x.value?.notes));
      if (!o || !o.value.notes.length) continue;
      const newest = learned.map((n) => n.ts).sort().pop();
      const merged = o.value.notes.slice(0, Math.ceil(max / 2))
        .filter((n) => n?.text)
        .map((n) => makeNote(n.text, { source: 'learned', scope, ts: typeof n.ts === 'string' && !isNaN(Date.parse(n.ts)) ? n.ts : newest }));
      const keep = list.filter((n) => n.source !== 'learned');
      const next = mergeNotes(merged, keep);
      this.memory.replaceAll(scope === 'global' ? { global: next } : { project: next });
    }
  }
}

/** An error the REPL can print as-is (no stack, no "fetch failed"). */
function friendly(e, message) { const err = new Error(message || e.message); err.friendly = true; err.cause = e; err.unreachable = e.unreachable; err.oom = e.oom; return err; }

function safeJson(s) { try { return parseLenient(s); } catch { return {}; } }

/** Parameter count in billions from Ollama's details ("3.1B") or the tag ("qwen2.5-coder:1.5b"). */
export function modelSizeB(model, paramSize) {
  const p = /([\d.]+)\s*([BM])/i.exec(String(paramSize || ''));
  if (p) return Number(p[1]) / (p[2].toUpperCase() === 'M' ? 1000 : 1);
  const m = /[:\-_](\d+(?:\.\d+)?)b\b/i.exec(String(model || ''));
  return m ? Number(m[1]) : Infinity;
}

function summarizeArgs(a = {}) {
  const v = a.path ?? a.pattern ?? a.command ?? '';
  return c.gray(String(v).slice(0, 80));
}
