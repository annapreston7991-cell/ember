/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// `ember --debug` / EMBER_DEBUG=1: write raw model replies and tool-parse decisions to
// ~/.ember/logs/ember-<time>.log (JSON lines) so problems can be diagnosed from the user's machine.
// The log holds prompts and code from the session; API keys are redacted. Nothing is sent anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emberHome } from './config.js';

let file = null;

export function debugEnabled() { return !!file; }
export function debugFile() { return file; }

export function enableDebug() {
  if (file) return file;
  const dir = path.join(emberHome(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, `ember-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  fs.writeFileSync(file, '', { mode: 0o600 });
  return file;
}

const SECRET_KEYS = /(api[_-]?key|token|secret|password|authorization|license|key)$/i;
export function redact(v, depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) && typeof x === 'string' && x ? '[redacted]' : redact(x, depth + 1);
  return out;
}

/** Append one event. Cheap no-op unless debugging is on. */
export function dlog(event, data = {}) {
  if (!file) return;
  try {
    const clean = JSON.stringify({ t: new Date().toISOString(), event, ...redact(data) }, (k, v) => (typeof v === 'string' && v.length > 20000 ? `${v.slice(0, 20000)}…[${v.length - 20000} more chars]` : v));
    fs.appendFileSync(file, clean.replace(/\b(sk|xai|gsk|or)-[A-Za-z0-9_-]{16,}/g, '[redacted-key]') + '\n');
  } catch { /* never let logging break a session */ }
}

export function debugHeader({ version, cfg, extra = {} }) {
  dlog('start', {
    version, node: process.versions.node, platform: process.platform, arch: os.arch(), release: os.release(),
    hostname: os.hostname(), ramGB: +(os.totalmem() / 1024 ** 3).toFixed(1), freeGB: +(os.freemem() / 1024 ** 3).toFixed(1),
    cpus: os.cpus().length, stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY, cwd: process.cwd(),
    cfg: { ...cfg, _exists: undefined }, ...extra
  });
}
