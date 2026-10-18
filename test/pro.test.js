/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quietUI, tmpdir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const L = await import('../src/license.js');
const P = await import('../src/pro.js');
const { clientFor } = await import('../src/clients.js');
const { Memory } = await import('../src/memory.js');
const { loadPlugins } = await import('../src/plugins.js');
const { DEFAULTS } = await import('../src/config.js');
const { PRO_PUBLIC_KEY } = await import('../src/pro-public-key.js');

// A throwaway key pair, made fresh for each run. The real private key is never in the repo.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUB = publicKey.export({ type: 'spki', format: 'pem' });

function withTestKey(fn) {
  L.setPublicKeyForTesting(PUB); P.clearProCache();
  const saved = process.env.EMBER_PRO_KEY, home = process.env.EMBER_HOME;
  process.env.EMBER_HOME = tmpdir('ember-home-');
  return Promise.resolve().then(fn).finally(() => {
    L.setPublicKeyForTesting(null); P.clearProCache();
    if (saved === undefined) delete process.env.EMBER_PRO_KEY; else process.env.EMBER_PRO_KEY = saved;
    if (home === undefined) delete process.env.EMBER_HOME; else process.env.EMBER_HOME = home;
  });
}

test('license keys: valid, tampered, wrong signer, expired (with grace), not yet valid, malformed', () => withTestKey(() => {
  const now = Date.UTC(2026, 9, 17);
  const key = L.signLicense({ id: 'sub_test', days: 30, now }, PRIV);
  assert.ok(key.startsWith('EMBER-PRO-'));
  const ok = L.verifyLicense(key, { now });
  assert.equal(ok.valid, true);
  assert.equal(ok.payload.id, 'sub_test');
  assert.deepEqual(Object.keys(ok.payload).sort(), ['exp', 'iat', 'id', 'plan', 'product', 'seats', 'v'], 'no personal data in the key');
  // tamper with the payload (extend expiry) → signature fails
  const [p, s] = key.slice(10).split('.');
  const forged = JSON.parse(Buffer.from(p, 'base64url')); forged.exp += 365 * 86400;
  assert.match(L.verifyLicense(`EMBER-PRO-${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`, { now }).reason, /signature/);
  // signed by somebody else
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.match(L.verifyLicense(L.signLicense({ id: 'x', now }, other), { now }).reason, /signature/);
  const day = 86400000;
  assert.equal(L.verifyLicense(key, { now: now + 32 * day }).valid, true, 'within the 3-day grace period');
  assert.match(L.verifyLicense(key, { now: now + 34 * day }).reason, /expired on 2026-11-16/);
  assert.equal(L.verifyLicense(key, { now: now + 27 * day }).expiresSoon, true);
  assert.match(L.verifyLicense(key, { now: now - 3 * day }).reason, /not valid yet/);
  assert.match(L.verifyLicense('hello', { now }).reason, /should start with EMBER-PRO-/);
  assert.match(L.verifyLicense('EMBER-PRO-abc', { now }).reason, /malformed/);
  assert.equal(L.verifyLicense(` ${key.slice(0, 40)}\n${key.slice(40)} `, { now }).valid, true, 'whitespace from copy/paste is ignored');
}));

test('the real public key is used by default and rejects test-signed keys', () => {
  L.setPublicKeyForTesting(null);
  assert.match(PRO_PUBLIC_KEY, /BEGIN PUBLIC KEY/);
  assert.equal(crypto.createPublicKey(PRO_PUBLIC_KEY).asymmetricKeyType, 'ed25519');
  assert.match(L.verifyLicense(L.signLicense({ id: 'x' }, PRIV)).reason, /signature/);
});

test('isPro: from EMBER_PRO_KEY, config, or ~/.ember/license.key; free when absent', () => withTestKey(() => {
  assert.equal(P.isPro({}), false);
  process.env.EMBER_PRO_KEY = L.signLicense({ id: 'env' }, PRIV); P.clearProCache();
  assert.equal(P.proStatus({}).from, 'EMBER_PRO_KEY');
  assert.equal(P.isPro({}), true);
  delete process.env.EMBER_PRO_KEY; P.clearProCache();
  assert.equal(P.isPro({ pro: { licenseKey: L.signLicense({ id: 'cfg' }, PRIV) } }), true);
  fs.mkdirSync(process.env.EMBER_HOME, { recursive: true });
  fs.writeFileSync(P.licenseFile(), L.signLicense({ id: 'file' }, PRIV)); P.clearProCache();
  assert.equal(P.proStatus({}).id, 'file');
  fs.writeFileSync(P.licenseFile(), 'EMBER-PRO-garbage.sig'); P.clearProCache();
  assert.equal(P.isPro({}), false);
}));

test('gates: cloud models, team memory and premium plugins need Pro; local stays free', () => withTestKey(async () => {
  const cfg = structuredClone(DEFAULTS);
  assert.equal(clientFor('qwen2.5-coder:7b', cfg).cloud, false, 'local models never need Pro');
  assert.throws(() => clientFor('cloud:grok-4', cfg), (e) => e.code === 'PRO_REQUIRED' && /Cloud models[\s\S]*Ember Pro[\s\S]*ember pro activate/.test(e.message));
  const root = tmpdir();
  const free = new Memory(root, cfg);
  assert.throws(() => free.remember('we use pnpm', { scope: 'team' }), /Team memory[\s\S]*Ember Pro/);
  fs.mkdirSync(path.join(root, '.ember'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ember', 'team.md'), '- Always add a CHANGELOG entry\n');
  assert.doesNotMatch(new Memory(root, cfg).forPrompt('x'), /CHANGELOG/, 'team notes are not used without Pro');
  const gdir = path.join(process.env.EMBER_HOME, 'plugins'); fs.mkdirSync(gdir, { recursive: true });
  fs.writeFileSync(path.join(gdir, 'fancy.mjs'), "export default { name: 'fancy', description: 'premium', pro: true, run() { return 'ok'; } };");
  let r = await loadPlugins({ root, cfg, confirmTrust: async () => true });
  assert.ok(r.skipped.some((s) => /premium plugin/.test(s.reason)));

  process.env.EMBER_PRO_KEY = L.signLicense({ id: 'pro' }, PRIV); P.clearProCache();
  assert.equal(clientFor('cloud:grok-4', cfg).cloud, true);
  const pro = new Memory(root, cfg);
  assert.match(pro.forPrompt('changelog'), /\(team\) Always add a CHANGELOG entry/);
  pro.remember('We deploy with Fly.io', { scope: 'team' });
  assert.match(fs.readFileSync(path.join(root, '.ember', 'team.md'), 'utf8'), /Fly\.io/);
  r = await loadPlugins({ root, cfg, confirmTrust: async () => true });
  assert.ok(r.tools.some((t) => t.def.function.name === 'fancy'));
}));

test('ember pro CLI: status when free, bad keys refused, deactivate', () => {
  const home = tmpdir('ember-home-');
  const run = (...a) => spawnSync(process.execPath, [path.join(here, '..', 'bin', 'ember.js'), 'pro', ...a], { env: { ...process.env, EMBER_HOME: home, EMBER_PRO_KEY: '' }, encoding: 'utf8' });
  let r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not active[\s\S]*Free features are all on[\s\S]*Cloud models/);
  r = run('activate', 'EMBER-PRO-nope.nope');
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /doesn't work: signature check failed/);
  assert.ok(!fs.existsSync(path.join(home, 'license.key')));
  r = run('deactivate');
  assert.equal(r.status, 0);
});

test('no private key material or secrets are committed', () => {
  const files = spawnSync('git', ['ls-files'], { cwd: path.join(here, '..'), encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const f of files) {
    if (/\.(png|vsix|ico)$/.test(f)) continue;
    const t = fs.readFileSync(path.join(here, '..', f), 'utf8');
    // Patterns are assembled from pieces so this file doesn't match itself.
    assert.doesNotMatch(t, new RegExp('-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIV' + 'ATE KEY-----\\n[A-Za-z0-9+/]'), f);
    assert.doesNotMatch(t, new RegExp('\\b(' + ['sk', 'rk'].map((x) => x + '_live_[A-Za-z0-9]{10,}').join('|') + '|xai-[A-Za-z0-9]{20,}|gh' + 'p_[A-Za-z0-9]{20,})'), f);
  }
});
