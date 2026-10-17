/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { TOOL_DEFS, TOOL_NAMES, executeTool } from './tools.js';
import { parseToolCalls, findJsonObjects } from './parser.js';
import { systemPrompt, DISTILL_PROMPT, CONSOLIDATE_PROMPT } from './prompt.js';
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
    const safe = this.buf.length - 12;
    if (safe > this.printed) { this.write(this.buf.slice(this.printed, safe)); this.printed = safe; }
  }
  end() {
    if (!this.stopped && this.printed < this.buf.length) this.write(this.buf.slice(this.printed));
    this.printed = this.buf.length;
  }
}

export class Agent {
  constructor({ cfg, root, ui, client, memory }) {
    this.cfg = cfg;
    this.root = root;
    this.ui = ui;
    this.client = client;
    this.memory = memory;
    this.messages = [];
    this.native = null; // null = unknown, true = native tools, false = JSON fallback
    this.ctx = {
      root, ui, cfg, memory, backups: [], plan: [],
      always: { writes: false, commands: new Set() },
      session: { events: [], writes: new Map(), said: [] }
    };
  }

  get model() { return this.cfg.model; }

  async init() {
    const caps = await this.client.supportsTools(this.model);
    this.native = caps === false ? false : true;
    try { this.emberMd = fs.readFileSync(path.join(this.root, 'EMBER.md'), 'utf8'); } catch { this.emberMd = ''; }
    if (this.memory?.enabled) {
      try { this.memory.detected = detectRepoStyle(this.root); } catch { this.memory.detected = []; }
    }
  }

  clear() { this.messages = []; this.ctx.plan = []; }

  system(query) {
    return systemPrompt({
      root: this.root, toolNames: TOOL_NAMES, fallback: !this.native,
      emberMd: this.emberMd, memory: this.memory?.forPrompt(query)
    });
  }

  trimContext() {
    const budget = (this.cfg.numCtx || 8192) * 3; // ~chars
    let total = this.messages.reduce((n, m) => n + (m.content?.length || 0), 0);
    for (let i = 0; i < this.messages.length - 6 && total > budget; i++) {
      const m = this.messages[i];
      if ((m.role === 'tool' || m._toolResult) && m.content.length > 200) {
        total -= m.content.length - 40;
        m.content = '[older tool output trimmed]';
      }
    }
  }

  async chatOnce(signal, sys) {
    const filter = new StreamFilter((s) => this.ui.write(s));
    const msgs = [{ role: 'system', content: sys }, ...this.messages.map(({ _toolResult, ...m }) => m)];
    const opts = { num_ctx: this.cfg.numCtx, temperature: this.cfg.temperature };
    try {
      const r = await this.client.chat({ model: this.model, messages: msgs, tools: this.native ? TOOL_DEFS : undefined, options: opts, onToken: (t) => filter.push(t), signal });
      filter.end();
      return r;
    } catch (e) {
      if (e.noTools && this.native) {
        this.native = false;
        this.ui.print(c.gray('(model has no native tool calling; using JSON tool mode)'));
        return this.chatOnce(signal, this.system(this.lastQuery));
      }
      throw e;
    }
  }

  /** Run one user turn through the agent loop. Returns the final assistant text. */
  async run(userText, { signal } = {}) {
    this.lastQuery = userText;
    if (this.memory?.enabled) {
      for (const p of detectStatedPreferences(userText)) {
        const r = this.memory.remember(p.text, { scope: p.scope, source: 'said' });
        this.ctx.session.said.push(p.text);
        if (r.added) this.ui.print(c.gray(`  (noted${p.scope === 'project' ? ' for this project' : ''}: "${p.text}" · /forget to undo)`));
      }
    }
    this.messages.push({ role: 'user', content: userText });
    const seen = new Map();
    let finalText = '';
    let stuck = 0;
    for (let step = 0; step < (this.cfg.maxSteps || 25); step++) {
      if (signal?.aborted) throw new Error('aborted');
      this.trimContext();
      const r = await this.chatOnce(signal, this.system(userText));
      let calls = (r.tool_calls || []).map((tc) => ({ name: tc.function?.name, arguments: typeof tc.function?.arguments === 'string' ? safeJson(tc.function.arguments) : (tc.function?.arguments || {}) }));
      let viaText = false;
      let text = r.content || '';
      if (!calls.length) {
        const parsed = parseToolCalls(text, TOOL_NAMES);
        if (parsed.calls.length) { calls = parsed.calls; viaText = true; text = parsed.text; }
      }
      if (!calls.length) {
        this.messages.push({ role: 'assistant', content: r.content || '' });
        finalText = text;
        if (text && !text.endsWith('\n')) this.ui.write('\n');
        break;
      }
      if (viaText || !this.native) this.messages.push({ role: 'assistant', content: r.content || '' });
      else this.messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.tool_calls });

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
          if (!['write_file', 'edit_file', 'run_command', 'update_plan', 'remember'].includes(call.name)) {
            this.ui.print(c.gray(`  · ${call.name} ${summarizeArgs(call.arguments)}`));
          }
          try { result = String(await executeTool(this.ctx, call.name, call.arguments || {})); }
          catch (e) { result = `Error: ${e.message}`; this.ui.print(c.red(`  ✗ ${e.message}`)); }
        }
        if (viaText || !this.native) this.messages.push({ role: 'user', content: `Result of ${call.name}:\n${result}`, _toolResult: true });
        else this.messages.push({ role: 'tool', content: result, tool_name: call.name });
      }
      stuck = progressed ? 0 : stuck + 1;
      if (stuck >= 2) {
        this.ui.print(c.gray('(the model is repeating itself, so Ember stopped this turn)'));
        break;
      }
      if (step === (this.cfg.maxSteps || 25) - 1) this.ui.warn('Reached the step limit for this turn. Say "continue" to keep going.');
    }
    return finalText;
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
      const r = await this.client.chat({ model: this.model, messages: [{ role: 'system', content: DISTILL_PROMPT }, { role: 'user', content: log }], options: { temperature: 0, num_ctx: this.cfg.numCtx }, signal });
      content = r.content;
    } catch { return []; }
    const learned = [];
    for (const o of findJsonObjects(content || '')) {
      if (!Array.isArray(o.value?.notes)) continue;
      for (const n of o.value.notes.slice(0, 5)) {
        const text = typeof n === 'string' ? n : n?.text;
        if (!text || text.length < 6 || text.length > 200) continue;
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
        const r = await this.client.chat({ model: this.model, messages: [{ role: 'system', content: CONSOLIDATE_PROMPT }, { role: 'user', content: learned.map((n) => JSON.stringify({ text: n.text, ts: n.ts })).join('\n') }], options: { temperature: 0, num_ctx: this.cfg.numCtx }, signal });
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

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

function summarizeArgs(a = {}) {
  const v = a.path ?? a.pattern ?? a.command ?? '';
  return c.gray(String(v).slice(0, 80));
}
