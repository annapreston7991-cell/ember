/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Optional cloud models through OpenAI-compatible APIs (xAI Grok, OpenAI, OpenRouter,
// LM Studio, vLLM...). Local Ollama stays the default; nothing here runs unless the
// user picks a "cloud:" model. Keys come only from env vars or ~/.ember/config.json (0600).
import fs from 'node:fs';
import { configPath } from './config.js';

export const BUILTIN_PROVIDERS = {
  grok: { baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY', label: 'xAI Grok' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', label: 'OpenAI' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', label: 'OpenRouter' }
};

/**
 * "cloud:grok-4"            → provider grok, model grok-4
 * "cloud:openai:gpt-4.1"    → provider openai, model gpt-4.1
 * "cloud:mylab:qwen-72b"    → provider from cfg.providers.mylab
 * Returns null for local (Ollama) model names.
 */
export function parseModelRef(ref, cfg = {}) {
  if (typeof ref !== 'string' || !ref.startsWith('cloud:')) return null;
  const rest = ref.slice(6);
  const providers = { ...BUILTIN_PROVIDERS, ...(cfg.providers || {}) };
  const i = rest.indexOf(':');
  if (i > 0 && providers[rest.slice(0, i)]) return { provider: rest.slice(0, i), model: rest.slice(i + 1) };
  if (/^grok/i.test(rest)) return { provider: 'grok', model: rest };
  return { provider: cfg.cloud?.defaultProvider || 'grok', model: rest };
}

export function providerConfig(name, cfg = {}) {
  const p = { ...(BUILTIN_PROVIDERS[name] || {}), ...((cfg.providers || {})[name] || {}) };
  if (!p.baseUrl) throw new Error(`Unknown cloud provider "${name}". Add it under "providers" in ${configPath()}`);
  const apiKey = (p.apiKeyEnv && process.env[p.apiKeyEnv]) || p.apiKey || '';
  return { ...p, name, apiKey };
}

/** Warn when a key is stored in a config file that others can read. */
export function configPermsOk() {
  try {
    if (process.platform === 'win32') return true;
    return (fs.statSync(configPath()).mode & 0o077) === 0;
  } catch { return true; }
}

function toOpenAiMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id || 'call_0', content: m.content };
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant', content: m.content || null,
        tool_calls: m.tool_calls.map((tc, i) => ({
          id: tc.id || `call_${i}`, type: 'function',
          function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}) }
        }))
      };
    }
    if (m.images?.length) {
      return { role: m.role, content: [{ type: 'text', text: m.content }, ...m.images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }))] };
    }
    return { role: m.role, content: m.content };
  });
}

export class OpenAICompatClient {
  constructor(provider) {
    this.p = provider;
    this.isCloud = true;
    this.label = provider.label || provider.name;
  }

  async version() { return this.p.apiKey || this.p.noKey ? `${this.label} (cloud)` : null; }
  async listModels() {
    const r = await fetch(`${this.p.baseUrl}/models`, { headers: this.headers() });
    if (!r.ok) throw new Error(`${this.label} /models failed: ${r.status}`);
    const j = await r.json();
    return (j.data || []).map((m) => ({ name: `cloud:${this.p.name}:${m.id}`, size: 0 }));
  }
  async hasModel() { return Boolean(this.p.apiKey || this.p.noKey); }
  async supportsTools() { return true; }
  async pull() { throw new Error('Cloud models do not need to be downloaded.'); }

  headers() {
    const h = { 'content-type': 'application/json' };
    if (this.p.apiKey) h.authorization = `Bearer ${this.p.apiKey}`;
    return h;
  }

  async chat({ model, messages, tools, options = {}, onToken = () => {}, signal }) {
    if (!this.p.apiKey && !this.p.noKey) throw new Error(`No API key for ${this.label}. Set ${this.p.apiKeyEnv || 'apiKey'} in your environment.`);
    const body = { model, messages: toOpenAiMessages(messages), stream: true };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (tools?.length) body.tools = tools;
    const r = await fetch(`${this.p.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    if (!r.ok) throw new Error(`${this.label} error ${r.status}: ${(await r.text()).slice(0, 500)}`);
    let content = '';
    const calls = [];
    const decoder = new TextDecoder();
    let buf = '';
    const handle = (data) => {
      if (data === '[DONE]') return;
      const j = JSON.parse(data);
      const d = j.choices?.[0]?.delta || {};
      if (d.content) { content += d.content; onToken(d.content); }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] ||= { id: tc.id, function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    };
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
    }
    if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim());
    const tool_calls = calls.filter(Boolean).map((c) => {
      let args = {};
      try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { args = {}; }
      return { id: c.id, function: { name: c.function.name, arguments: args } };
    });
    return { content, tool_calls };
  }
}
