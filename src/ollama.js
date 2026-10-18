/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync as fsExists } from 'node:fs';
import { hostname as osHostname } from 'node:os';

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

const NET_CODES = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT|EPIPE/;
const OOM_RE = /(requires more system memory|more memory than is available|out of memory|cannot allocate|unable to allocate|insufficient memory|failed to allocate|signal: killed|llama runner process (has )?terminated|runner process no longer running|exit status (137|-1|2)|model runner has unexpectedly stopped)/i;

/** Turn low-level fetch failures into errors that say what is wrong (never a bare "fetch failed"). */
export function ollamaError(e, host, { model, phase = 'request' } = {}) {
  if (e?.unreachable || e?.oom || e?.name === 'AbortError') return e;
  const code = e?.cause?.code || e?.code || '';
  const msg = `${e?.message || e} ${e?.cause?.message || ''}`;
  if (NET_CODES.test(code) || /fetch failed|other side closed|socket hang up|terminated/i.test(msg)) {
    // A reset in the middle of a reply usually means the model runner crashed (often out of memory).
    if (phase === 'stream' || /ECONNRESET|other side closed|terminated/i.test(`${code} ${msg}`)) {
      const err = new Error(`Ollama stopped while ${model ? `running ${model}` : 'answering'} (connection lost). This usually means it ran out of memory.`);
      err.oom = true; err.crashed = true; err.host = host; err.model = model;
      return err;
    }
    const err = new Error(`Can't reach Ollama at ${host} (${code || 'connection failed'}). Is it running? Start it with: ollama serve`);
    err.unreachable = true; err.host = host;
    return err;
  }
  return e;
}

export function isOomMessage(text) { return OOM_RE.test(String(text || '')); }

/** Plain advice for a model that doesn't fit in memory. */
export function oomAdvice({ model, ramGB, running = [] } = {}) {
  const tips = [];
  const others = running.filter((m) => m.name !== model);
  if (others.length) tips.push(`Close other loaded models: ${others.map((m) => `ollama stop ${m.name}`).join(' ; ')}`);
  tips.push(`Use a smaller model: ember -m qwen2.5-coder:1.5b  (or /model qwen2.5-coder:1.5b)`);
  if (isCrostini()) tips.push('ChromeOS: give Linux more memory in Settings → About ChromeOS → Developers → Linux development environment (or close Chrome tabs and Android apps).');
  else tips.push('Close memory-hungry apps (browsers, editors) and try again.');
  tips.push('No room for a local model at all? See "Low-memory machines" in the README (Ollama cloud models, or Ember Pro cloud models).');
  return `${model ? `${model} ` : 'The model '}does not fit in the free memory${ramGB ? ` (${ramGB} GB total here)` : ''}. Try:\n${tips.map((t) => `  - ${t}`).join('\n')}`;
}

/** ChromeOS Linux (Crostini): the container is called "penguin" and has cros-specific files. */
export function isCrostini() {
  try {
    if (process.platform !== 'linux') return false;
    if (fsExists('/dev/.cros_milestone') || fsExists('/etc/apt/sources.list.d/cros.list') || fsExists('/opt/google/cros-containers')) return true;
    return osHostname() === 'penguin';
  } catch { return false; }
}

export class OllamaClient {
  constructor(host = 'http://127.0.0.1:11434', { keepAlive = '30m' } = {}) {
    this.host = host.replace(/\/+$/, '');
    this.keepAlive = keepAlive; // keep the model loaded between turns (Ollama's default is 5m)
    this._caps = new Map();
    this._params = new Map();
  }

  /** "1.5B"-style parameter size seen by supportsTools(), if Ollama reported one. */
  paramSize(model) { return this._params.get(model) || null; }

  /** Models currently loaded in memory (/api/ps): [{ name, size, size_vram, expires_at }]. */
  async listRunning({ timeoutMs = 2000 } = {}) {
    try {
      const r = await fetch(`${this.host}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return [];
      return (await r.json()).models || [];
    } catch { return []; }
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

  async listModels({ timeoutMs } = {}) {
    let r;
    try { r = await fetch(`${this.host}/api/tags`, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}); }
    catch (e) { throw ollamaError(e, this.host); }
    if (!r.ok) throw new Error(`Ollama /api/tags failed: ${r.status}`);
    return (await r.json()).models || [];
  }

  async hasModel(name, opts) {
    const models = await this.listModels(opts);
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
        if (j.details?.parameter_size) this._params.set(model, j.details.parameter_size);
        if (Array.isArray(j.capabilities)) result = j.capabilities.includes('tools');
        else if (typeof j.template === 'string') result = /\.Tools\b/.test(j.template);
      }
    } catch { /* unknown */ }
    this._caps.set(model, result);
    return result;
  }

  /** Embeddings for a batch of texts via /api/embed. */
  async embed(model, input) {
    let r;
    try {
      r = await fetch(`${this.host}/api/embed`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input, keep_alive: this.keepAlive })
      });
    } catch (e) { throw ollamaError(e, this.host, { model }); }
    if (!r.ok) throw new Error(`embed failed: ${r.status} ${await r.text()}`);
    return (await r.json()).embeddings || [];
  }

  async pull(model, onProgress = () => {}) {
    let r;
    try {
      r = await fetch(`${this.host}/api/pull`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true })
      });
    } catch (e) { throw ollamaError(e, this.host, { model }); }
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
    let r;
    try {
      r = await fetch(`${this.host}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal
      });
    } catch (e) { throw ollamaError(e, this.host, { model }); }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      let detail = text;
      try { detail = JSON.parse(text).error || text; } catch { /* plain text */ }
      const err = new Error(isOomMessage(detail) ? `Ollama could not load ${model}: ${detail}` : r.status === 404 && /not found/i.test(detail) ? `Model ${model} is not installed in Ollama. Run: ollama pull ${model}` : `Ollama chat failed (${r.status}): ${detail}`);
      err.noTools = /does not support tools/i.test(text);
      err.oom = isOomMessage(detail);
      err.status = r.status; err.model = model; err.host = this.host;
      throw err;
    }
    let content = '';
    const toolCalls = [];
    const t0 = Date.now();
    let firstToken = null;
    let stats = {};
    try {
    await readNdjson(r, (o) => {
      if (o.error) { const err = new Error(isOomMessage(o.error) ? `Ollama could not run ${model}: ${o.error}` : o.error); err.oom = isOomMessage(o.error); err.model = model; throw err; }
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
    } catch (e) { if (signal?.aborted) throw e; throw ollamaError(e, this.host, { model, phase: 'stream' }); }
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

/** Poll /api/version with exponential backoff (250 ms, 500 ms, 1 s, 2 s…) until it answers. */
export async function waitForServer(client, { timeoutMs = 20000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = Date.now() + timeoutMs;
  for (let delay = 250; ; delay = Math.min(delay * 2, 2000)) {
    if (await client.version()) return true;
    if (Date.now() + delay > until) return false;
    await sleep(delay);
  }
}

/** Start `ollama serve` in the background and wait until it answers. */
export async function ensureServer(client, { timeoutMs = 20000, start = true } = {}) {
  if (await client.version()) return true;
  if (!start) return false;
  const bin = ollamaBinary();
  if (!bin) return false;
  const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return waitForServer(client, { timeoutMs });
}
