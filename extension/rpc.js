/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
'use strict';
// JSON-RPC 2.0 client for `ember serve` (newline-delimited JSON over stdio). No VS Code APIs here,
// so it can be tested with plain Node.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');

class EmberClient extends EventEmitter {
  constructor({ command = 'ember', args = ['serve'], cwd, env } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env || process.env;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.proc = null;
  }

  /** Answer server → client requests (approval, input). fn(params) → result. */
  onRequest(method, fn) { this.handlers.set(method, fn); return this; }

  start() {
    if (this.proc) return this;
    const shell = process.platform === 'win32';
    this.proc = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell });
    this.proc.on('error', (e) => { this.emit('error', e); this.failAll(e); });
    this.proc.on('exit', (code, sig) => { this.emit('exit', { code, signal: sig }); this.failAll(new Error(`ember serve exited (${code ?? sig})`)); this.proc = null; });
    this.proc.stderr.on('data', (b) => this.emit('stderr', b.toString()));
    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => this.onLine(l));
    return this;
  }

  failAll(err) { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); }

  write(msg) {
    if (!this.proc) throw new Error('ember serve is not running');
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  async onLine(line) {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { this.emit('garbage', line); return; }
    if (m.method === undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) { const e = new Error(m.error.message); e.code = m.error.code; p.reject(e); } else p.resolve(m.result);
      return;
    }
    if (m.id === undefined) { this.emit('notification', m.method, m.params || {}); this.emit(m.method, m.params || {}); return; }
    const h = this.handlers.get(m.method);
    try {
      const result = h ? await h(m.params || {}) : null;
      this.write({ id: m.id, result: result ?? {} });
    } catch (e) {
      this.write({ id: m.id, error: { code: -32000, message: String(e && e.message || e) } });
    }
  }

  async stop() {
    if (!this.proc) return;
    const p = this.proc;
    try { await Promise.race([this.request('shutdown'), new Promise((r) => setTimeout(r, 1500))]); } catch { /* exiting */ }
    setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 500).unref?.();
  }
}

module.exports = { EmberClient };
