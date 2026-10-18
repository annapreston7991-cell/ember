/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Which models are installed / loaded, which optional extras are missing, and low-memory mode.
import os from 'node:os';
import { c } from './ui.js';
import { isCrostini } from './ollama.js';

export const CONFIG_VERSION = 2; // 2 = v0.2.1: extras (embeddings, vision, fast model) offered once after an update

const CODER = /(coder|code|devstral|starcoder|codellama|codegemma|granite-code|deepseek-coder|codestral|qwen3-coder)/i;

export function sizeOf(name) {
  const m = /[:\-_](\d+(?:\.\d+)?)b\b/i.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

/** Low-memory mode: about 6 GB of RAM or less visible to this system (e.g. ChromeOS Linux with 3 GB). */
export function isLowMemory(cfg = {}, ramGB = os.totalmem() / 1024 ** 3) {
  if (cfg.lowMemory === true || cfg.lowMemory === false) return cfg.lowMemory;
  return ramGB <= 6.5;
}

/**
 * Low-memory mode settings for this session (not saved): one model for everything, no parallel
 * helpers, no second model loaded for embeddings at session start, and a shorter keep_alive so
 * Ember's model is unloaded sooner when you go back to other apps.
 */
export function applyLowMemory(cfg) {
  if (!isLowMemory(cfg)) return false;
  cfg._lowMemory = true;
  cfg.fastModel = null;
  if (cfg.team?.enabledByUser !== true) cfg.team = { ...(cfg.team || {}), enabled: false };
  cfg.index = { ...(cfg.index || {}), sessionEmbeddings: false };
  if (!cfg.keepAliveByUser) cfg.keepAlive = '10m';
  return true;
}

/** Installed models that look made for code, smallest first. */
export function coderModels(installed) {
  return installed.filter((m) => CODER.test(m.name) && !/embed/i.test(m.name)).sort((a, b) => (sizeOf(a.name) ?? 99) - (sizeOf(b.name) ?? 99));
}

/**
 * An already-installed coding model worth using instead of downloading the recommended one
 * (same size or smaller, so it fits). Returns a name or null.
 */
export function reusableModel(installed, recommended) {
  if (installed.some((m) => m.name === recommended)) return recommended;
  const want = sizeOf(recommended) ?? 7;
  const fits = coderModels(installed).filter((m) => (sizeOf(m.name) ?? 99) <= want);
  return fits.length ? fits[fits.length - 1].name : null;
}

/** Optional models Ember can use, with what each is for and the exact pull command. */
export function optionalModels(cfg, { lowMemory = isLowMemory(cfg) } = {}) {
  const list = [
    { key: 'embed', model: cfg.index?.embedModel || 'nomic-embed-text', size: '~270 MB', what: 'smarter project index (search by meaning)', ok: cfg.index?.enabled !== false },
    { key: 'vision', model: cfg.visionModel || 'qwen2.5vl:3b', size: '~3.2 GB', what: 'look at screenshots and the live preview', ok: true, heavy: true }
  ];
  const main = sizeOf(cfg.model);
  if (!lowMemory && main && main > 3) list.push({ key: 'fast', model: cfg.fastModel || 'qwen2.5-coder:1.5b', size: '~1 GB', what: 'fast answers for quick jobs (explain, commit messages)', ok: true });
  return list.filter((x) => x.ok);
}

export async function missingOptional(client, cfg, opts) {
  let names = [];
  try { names = (await client.listModels({ timeoutMs: 3000 })).map((m) => m.name); } catch { return null; }
  const has = (n) => names.includes(n) || names.includes(`${n}:latest`);
  return optionalModels(cfg, opts).filter((x) => !has(x.model));
}

/** Warnings about the main model and memory, for doctor and startup. */
export function modelWarnings({ model, ramGB = Math.round(os.totalmem() / 1024 ** 3), running = [] }) {
  const out = [];
  const size = sizeOf(model);
  if (size && size <= 2) {
    out.push(`${model} is very small: it often answers with code in the chat instead of writing files, and gets multi-step tasks wrong. Ember will offer "Save to <file>?" when that happens. If you can, use qwen2.5-coder:3b (needs about 3 GB free): ollama pull qwen2.5-coder:3b && ember -m qwen2.5-coder:3b`);
  }
  const others = running.filter((m) => m.name !== model);
  if (others.length) {
    const gb = others.reduce((n, m) => n + (m.size || 0), 0) / 1024 ** 3;
    if (ramGB <= 8 || gb > ramGB * 0.3) out.push(`Other models are loaded in Ollama right now (${others.map((m) => `${m.name} ${(m.size / 1024 ** 3).toFixed(1)} GB`).join(', ')}). With ${ramGB} GB RAM they compete with Ember's model. Free them with: ${others.map((m) => `ollama stop ${m.name}`).join(' ; ')}`);
  }
  if (ramGB <= 4 && isCrostini()) out.push(`ChromeOS Linux has only ${ramGB} GB here. You can give it more in Settings → About ChromeOS → Developers → Linux development environment (newer ChromeOS versions let you change the memory/disk there), or close Chrome tabs and Android apps before using Ember.`);
  return out;
}

/** Ask (once) about missing extras; never downloads without a yes. Returns pulled model names. */
export async function offerExtras({ ui, client, cfg, yes = false, pull, interactive = true }) {
  const lowMemory = isLowMemory(cfg);
  const missing = await missingOptional(client, cfg, { lowMemory });
  if (!missing || !missing.length) return [];
  const pulled = [];
  for (const x of missing) {
    if (x.heavy && lowMemory) {
      ui.print(c.gray(`  · ${x.model} (${x.size}, ${x.what}) is skipped on this low-memory machine. Later: ollama pull ${x.model}`));
      continue;
    }
    if (!interactive || yes) { ui.print(c.gray(`  · optional: ${x.model} (${x.size}) for ${x.what}: ollama pull ${x.model}`)); continue; }
    const ok = await ui.confirm(`Optional: download ${x.model} (${x.size}) for ${x.what}?`, { allowAlways: false });
    if (ok !== 'y') { ui.print(c.gray(`  skipped. Later: ollama pull ${x.model}`)); continue; }
    try { await pull(x.model); pulled.push(x.model); ui.ok(`${x.model} downloaded`); if (x.key === 'fast') cfg.fastModel = x.model; }
    catch (e) { ui.warn(`${x.model} download failed (${e.message}). Later: ollama pull ${x.model}`); }
  }
  return pulled;
}
