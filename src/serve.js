/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * `ember serve`: JSON-RPC 2.0 over stdio (one JSON message per line) for editors.
 *
 * Client → server requests:
 *   initialize {root?}                  → {version, model, root, native, features, ready, problem?}
 *   chat {text, mode?: "agent"|"explain"} → {text}   (streams notifications while running)
 *   explain {file?, selection?, text?, language?, question?} → {text}
 *   cancel {}                           → {cancelled}
 *   reset {}                            → {}
 *   undo {}                             → {text}
 *   status {}                           → {busy, model, plan, team}
 *   shutdown {}                         → {}   (then the process exits)
 * Server → client notifications:  output {text} · stream {text} · plan {steps} · busy {busy}
 * Server → client requests (the client must answer):
 *   approval {kind: "change", path, before, after, label, stats}   → {answer: "y"|"n"|"a", feedback?}
 *   approval {kind: "confirm"|"danger", question}                   → {answer: "y"|"n"|"a"} / {answer: "yes"}
 *   input {prompt}                                                  → {text}
 * Nothing is ever written to stdout except protocol messages.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from './config.js';
import { Agent } from './agent.js';
import { Memory } from './memory.js';
import { clientFor } from './clients.js';
import { loadPlugins } from './plugins.js';
import { explainPrompt } from './repl.js';
import { undoLast, formatPlan } from './tools.js';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const strip = (s) => String(s ?? '').replace(ANSI, '');

/** Minimal JSON-RPC peer over a pair of streams (NDJSON). */
export class RpcPeer {
  constructor(input, output) {
    this.out = output;
    this.handlers = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.rl = readline.createInterface({ input, terminal: false });
    this.rl.on('line', (l) => this.onLine(l));
    this.closed = new Promise((r) => this.rl.on('close', r));
  }
  on(method, fn) { this.handlers.set(method, fn); }
  send(msg) { this.out.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); }
  notify(method, params) { this.send({ method, params }); }
  request(method, params) {
    const id = `s${this.nextId++}`;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async onLine(line) {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return this.send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (m.method === undefined && m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      return m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    const h = this.handlers.get(m.method);
    if (!h) { if (m.id !== undefined) this.send({ id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } }); return; }
    try {
      const result = await h(m.params || {});
      if (m.id !== undefined) this.send({ id: m.id, result: result ?? {} });
    } catch (e) {
      if (m.id !== undefined) this.send({ id: m.id, error: { code: e.code || -32000, message: strip(e.message) } });
    }
  }
}

/** The agent's UI, routed to the editor. Approvals go to the editor; --yes semantics still apply. */
export class RpcUI {
  constructor(peer, { yes = false } = {}) { this.peer = peer; this.yes = yes; }
  print(s = '') { this.peer.notify('output', { text: strip(s) }); }
  write(s) { this.peer.notify('stream', { text: strip(s) }); }
  info(s) { this.print(`› ${s}`); }
  warn(s) { this.print(`! ${s}`); }
  error(s) { this.print(`✗ ${s}`); }
  ok(s) { this.print(`✓ ${s}`); }
  thinking() { return () => {}; }
  close() {}
  async ask(prompt) { const r = await this.peer.request('input', { prompt: strip(prompt) }); return r?.text ?? ''; }
  async confirm(question, { allowAlways = true } = {}) {
    if (this.yes) { this.print(`${strip(question)} → auto-approved`); return 'y'; }
    const r = await this.peer.request('approval', { kind: 'confirm', question: strip(question), allowAlways });
    return r?.answer === 'a' ? (allowAlways ? 'a' : 'y') : r?.answer === 'y' ? 'y' : 'n';
  }
  async confirmDangerous(question) {
    // Never auto-approved, even with --yes: a human in the editor must say "yes".
    const r = await this.peer.request('approval', { kind: 'danger', question: strip(question) });
    return r?.answer === 'yes';
  }
  async reviewChange(change) {
    if (this.yes) { this.print(`✓ ${change.label} ${change.path} (auto-approved)`); return 'y'; }
    const r = await this.peer.request('approval', { kind: 'change', path: change.path, before: change.before, after: change.after, label: change.label, stats: change.stats });
    if (r?.feedback) this.lastFeedback = r.feedback;
    return r?.answer === 'a' ? 'a' : r?.answer === 'y' ? 'y' : 'n';
  }
}

export async function runServe({ root, yes = false, input = process.stdin, output = process.stdout, cfg = loadConfig(), version = '0' }) {
  const peer = new RpcPeer(input, output);
  const ui = new RpcUI(peer, { yes });
  let agent = null;
  let problem = null;
  let busy = null;

  async function boot(r) {
    const projectRoot = path.resolve(r || root);
    if (!fs.existsSync(projectRoot)) throw new Error(`Not a directory: ${projectRoot}`);
    const { client } = clientFor(cfg.model, cfg);
    problem = null;
    const ready = await client.hasModel(cfg.model).catch(() => false);
    if (!ready) problem = client.isCloud ? `No API key for ${cfg.model}.` : `Model ${cfg.model} is not available. Run "ember setup" in a terminal (is Ollama running?).`;
    const memory = new Memory(projectRoot, cfg);
    const { tools } = await loadPlugins({ root: projectRoot, cfg, confirmTrust: async (file) => (await ui.confirm(`Project plugin ${path.relative(projectRoot, file)} wants to add a tool (code from this repo). Trust it?`, { allowAlways: false })) === 'y' }).catch(() => ({ tools: [] }));
    agent = new Agent({ cfg, root: projectRoot, ui, client, memory, extraTools: tools });
    if (ready) await agent.init();
    return agent;
  }

  async function exclusive(fn) {
    if (busy) { const e = new Error('Ember is busy with another request. Cancel it first.'); e.code = -32001; throw e; }
    if (!agent) await boot();
    if (problem) { const e = new Error(problem); e.code = -32002; throw e; }
    busy = new AbortController();
    peer.notify('busy', { busy: true });
    try { return await fn(busy.signal); }
    finally { busy = null; peer.notify('busy', { busy: false }); peer.notify('plan', { steps: agent.ctx.plan, text: strip(formatPlan(agent.ctx.plan)) }); }
  }

  peer.on('initialize', async (p) => {
    await boot(p.root);
    return { version, model: agent.model, root: agent.root, native: agent.native, ready: !problem, problem, features: { chat: true, explain: true, approvals: true, undo: true, cancel: true, preview: false } };
  });
  peer.on('chat', ({ text, mode = 'agent' }) => exclusive(async (signal) => {
    if (!text || typeof text !== 'string') throw new Error('text is required');
    const out = mode === 'explain' ? await agent.explain(text, { signal }) : await agent.runTask(text, { signal });
    return { text: strip(out) };
  }));
  peer.on('explain', ({ file, selection, text, language, question, startLine }) => exclusive(async (signal) => {
    let prompt;
    if (selection) {
      const where = file ? `${file}${startLine ? ` (from line ${startLine})` : ''}` : 'the editor';
      prompt = `${question || 'Explain this code in plain language: what it does, how, and anything surprising or risky.'}\nCode selected in ${where}:\n\`\`\`${language || ''}\n${String(selection).slice(0, 12000)}\n\`\`\``;
    } else prompt = explainPrompt(file || text || '', agent.root);
    return { text: strip(await agent.explain(prompt, { signal })) };
  }));
  peer.on('cancel', () => { const had = !!busy; busy?.abort(); return { cancelled: had }; });
  peer.on('reset', () => { agent?.clear(); return {}; });
  peer.on('undo', () => {
    const r = agent && undoLast(agent.ctx);
    return r ? { text: r.deleted ? `Removed ${r.path} (it was new).` : `Restored ${r.path}.`, ...r } : { text: 'Nothing to undo.' };
  });
  peer.on('status', () => ({ busy: !!busy, model: agent?.model, plan: agent?.ctx.plan || [], team: agent?.team || null, problem }));
  peer.on('shutdown', () => { setTimeout(() => { peer.rl.close(); }, 10); return {}; });

  await peer.closed;
  if (busy) busy.abort();
  if (agent?.preview) await agent.preview.stop().catch(() => {});
  return 0;
}
