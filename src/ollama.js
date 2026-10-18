/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import { spawn, spawnSync } from 'node:child_process';

/** Read an NDJSON streaming response, calling onObj for each JSON line. */
async function readNdjson(res, onObj) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onObj(JSON.parse(line));
    }
  }
  if (buf.trim()) onObj(JSON.parse(buf.trim()));
}

export class OllamaClient {
  constructor(host = 'http://127.0.0.1:11434', { keepAlive = '30m' } = {}) {
    this.host = host.replace(/\/+$/, '');
    this.keepAlive = keepAlive; // keep the model loaded between turns (Ollama's default is 5m)
    this._caps = new Map();
  }

  /** Load a model into memory ahead of time so the first answer doesn't pay the load cost. */
  async warmup(model) {
    try {
      const r = await fetch(`${this.host}/api/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: this.keepAlive })
      });
      await r.text();
      return r.ok;
    } catch { return false; }
  }

  async version() {
    try {
      const r = await fetch(`${this.host}/api/version`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) return null;
      return (await r.json()).version || 'unknown';
    } catch { return null; }
  }

  async listModels() {
    const r = await fetch(`${this.host}/api/tags`);
    if (!r.ok) throw new Error(`Ollama /api/tags failed: ${r.status}`);
    return (await r.json()).models || [];
  }

  async hasModel(name) {
    const models = await this.listModels();
    const want = name.includes(':') ? name : `${name}:latest`;
    return models.some((m) => m.name === want || m.model === want || m.name === name);
  }

  /** Returns true/false when Ollama reports capabilities, or null if unknown. */
  async supportsTools(model) {
    if (this._caps.has(model)) return this._caps.get(model);
    let result = null;
    try {
      const r = await fetch(`${this.host}/api/show`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model })
      });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.capabilities)) result = j.capabilities.includes('tools');
        else if (typeof j.template === 'string') result = /\.Tools\b/.test(j.template);
      }
    } catch { /* unknown */ }
    this._caps.set(model, result);
    return result;
  }

  async pull(model, onProgress = () => {}) {
    const r = await fetch(`${this.host}/api/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true })
    });
    if (!r.ok) throw new Error(`Pull failed: ${r.status} ${await r.text()}`);
    let lastErr = null;
    await readNdjson(r, (o) => { if (o.error) lastErr = o.error; else onProgress(o); });
    if (lastErr) throw new Error(lastErr);
  }

  /**
   * Streaming chat. Returns { content, tool_calls }.
   * onToken(text) is called for each content delta.
   */
  async chat({ model, messages, tools, options, onToken = () => {}, signal }) {
    const body = { model, messages, stream: true, options, keep_alive: this.keepAlive };
    if (tools && tools.length) body.tools = tools;
    const r = await fetch(`${this.host}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal
    });
    if (!r.ok) {
      const text = await r.text();
      const err = new Error(`Ollama chat failed (${r.status}): ${text}`);
      err.noTools = /does not support tools/i.test(text);
      err.status = r.status;
      throw err;
    }
    let content = '';
    const toolCalls = [];
    const t0 = Date.now();
    let firstToken = null;
    let stats = {};
    await readNdjson(r, (o) => {
      if (o.error) throw new Error(o.error);
      const m = o.message || {};
      if (m.content) { if (firstToken === null) firstToken = Date.now() - t0; content += m.content; onToken(m.content); }
      if (Array.isArray(m.tool_calls)) toolCalls.push(...m.tool_calls);
      if (o.done) {
        stats = {
          promptTokens: o.prompt_eval_count || 0, outputTokens: o.eval_count || 0,
          loadMs: Math.round((o.load_duration || 0) / 1e6), promptMs: Math.round((o.prompt_eval_duration || 0) / 1e6),
          evalMs: Math.round((o.eval_duration || 0) / 1e6)
        };
      }
    });
    stats = { ...stats, model, wallMs: Date.now() - t0, firstTokenMs: firstToken ?? (Date.now() - t0) };
    this.log?.push(stats);
    return { content, tool_calls: toolCalls, stats };
  }
}

export function ollamaBinary() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  return null;
}

/** Start `ollama serve` in the background and wait until it answers. */
export async function ensureServer(client, { timeoutMs = 20000 } = {}) {
  if (await client.version()) return true;
  const bin = ollamaBinary();
  if (!bin) return false;
  const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore' });
  child.unref();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    if (await client.version()) return true;
  }
  return false;
}
