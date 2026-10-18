/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Ember Pro: an optional paid tier ($9/mo through the LLYVerse site). There is no billing code here.
// The license key is checked offline against the public key in src/pro-public-key.js.
// Free forever: the whole local agent (local models, tools, memory, index, helpers, preview, voice, editor).
// Pro: cloud models (xAI Grok / OpenAI-compatible APIs), team memory, premium plugins.
import fs from 'node:fs';
import path from 'node:path';
import { emberHome } from './config.js';
import { verifyLicense } from './license.js';

export const PRO_FEATURES = {
  'cloud-models': 'Cloud models (xAI Grok and OpenAI-compatible APIs)',
  'team-memory': 'Team memory shared through the repo (.ember/team.md)',
  'premium-plugins': 'Premium plugins'
};
export const PRO_URL = 'https://llyverse.org/ember#pro';

export const licenseFile = () => path.join(emberHome(), 'license.key');

/** Where the key comes from, in order: EMBER_PRO_KEY, config pro.licenseKey, ~/.ember/license.key. */
export function licenseKey(cfg = {}) {
  if (process.env.EMBER_PRO_KEY) return { key: process.env.EMBER_PRO_KEY, from: 'EMBER_PRO_KEY' };
  if (cfg.pro?.licenseKey) return { key: cfg.pro.licenseKey, from: 'config' };
  try { return { key: fs.readFileSync(licenseFile(), 'utf8').trim(), from: licenseFile() }; } catch { return { key: '', from: null }; }
}

const cache = new Map();
export function proStatus(cfg = {}) {
  const { key, from } = licenseKey(cfg);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.status;
  const r = verifyLicense(key);
  const status = { pro: r.valid, from, reason: r.reason, expires: r.payload?.exp ? new Date(r.payload.exp * 1000).toISOString().slice(0, 10) : null, seats: r.payload?.seats, id: r.payload?.id, expiresSoon: !!r.expiresSoon };
  cache.set(key, { at: Date.now(), status });
  return status;
}
export function clearProCache() { cache.clear(); }

export function isPro(cfg = {}) { return proStatus(cfg).pro; }

export class ProRequiredError extends Error {
  constructor(feature) {
    super(`${PRO_FEATURES[feature] || feature} ${/s$/.test(feature) ? 'are' : 'is'} part of Ember Pro ($9/mo). Get a key at ${PRO_URL}, then run: ember pro activate <key>. Everything local stays free.`);
    this.code = 'PRO_REQUIRED';
    this.feature = feature;
  }
}

export function requirePro(cfg, feature) { if (!isPro(cfg)) throw new ProRequiredError(feature); }

/** `ember pro [status|activate <key>|deactivate]` */
export async function proCommand({ ui, args, cfg }) {
  const [sub = 'status', key] = args;
  if (sub === 'activate') {
    if (!key) { ui.error('Usage: ember pro activate EMBER-PRO-…'); return 1; }
    const r = verifyLicense(key);
    if (!r.valid) { ui.error(`That key doesn't work: ${r.reason}.`); return 1; }
    fs.mkdirSync(emberHome(), { recursive: true });
    fs.writeFileSync(licenseFile(), key.trim() + '\n', { mode: 0o600 });
    fs.chmodSync(licenseFile(), 0o600);
    clearProCache();
    ui.ok(`Ember Pro is active until ${new Date(r.payload.exp * 1000).toISOString().slice(0, 10)}. Key saved to ${licenseFile()} (only you can read it). Thank you for supporting LLYVerse!`);
    return 0;
  }
  if (sub === 'deactivate') {
    if (fs.existsSync(licenseFile())) fs.rmSync(licenseFile());
    clearProCache();
    ui.ok('Removed the saved Pro key. (A key in EMBER_PRO_KEY or the config file still applies.)');
    return 0;
  }
  const st = proStatus(cfg);
  if (st.pro) ui.ok(`Ember Pro: active (key from ${st.from}) · expires ${st.expires}${st.expiresSoon ? ' — renews soon' : ''}`);
  else ui.print(`Ember Pro: not active${st.from ? ` (${st.reason})` : ''}. Free features are all on. Pro adds: ${Object.values(PRO_FEATURES).join('; ')}. ${PRO_URL}`);
  return 0;
}
