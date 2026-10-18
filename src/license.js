/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Ember Pro license keys: offline-verifiable Ed25519 signatures. No network, no telemetry.
//   key = "EMBER-PRO-" + base64url(JSON payload) + "." + base64url(signature)
//   signature = Ed25519("ember-pro-v1." + base64url(payload))
//   payload = { v: 1, product: "ember-pro", id, plan: "pro", seats, iat, exp }  (seconds since epoch)
import crypto from 'node:crypto';
import { PRO_PUBLIC_KEY } from './pro-public-key.js';

export const KEY_PREFIX = 'EMBER-PRO-';
const DOMAIN = 'ember-pro-v1.';
const b64u = (buf) => Buffer.from(buf).toString('base64url');

let publicKey = PRO_PUBLIC_KEY;
/** Tests only: verify against a throwaway key pair instead of the real one. */
export function setPublicKeyForTesting(pem) { publicKey = pem || PRO_PUBLIC_KEY; }

export function signLicense({ id, seats = 1, days = 35, plan = 'pro', now = Date.now() }, privateKeyPem) {
  if (!id) throw new Error('license id is required');
  const iat = Math.floor(now / 1000);
  const payload = { v: 1, product: 'ember-pro', id: String(id), plan, seats, iat, exp: iat + Math.round(days * 86400) };
  const p = b64u(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(DOMAIN + p), crypto.createPrivateKey(privateKeyPem));
  return `${KEY_PREFIX}${p}.${b64u(sig)}`;
}

/** Returns { valid, reason?, payload? }. Never throws. graceDays lets a lapsed key work a little longer offline. */
export function verifyLicense(key, { now = Date.now(), graceDays = 3 } = {}) {
  const k = String(key || '').trim().replace(/\s+/g, '');
  if (!k) return { valid: false, reason: 'no license key' };
  if (!k.startsWith(KEY_PREFIX)) return { valid: false, reason: `not an Ember Pro key (should start with ${KEY_PREFIX})` };
  const [p, s, extra] = k.slice(KEY_PREFIX.length).split('.');
  if (!p || !s || extra !== undefined) return { valid: false, reason: 'malformed key' };
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(DOMAIN + p), crypto.createPublicKey(publicKey), Buffer.from(s, 'base64url')); } catch { ok = false; }
  if (!ok) return { valid: false, reason: 'signature check failed (key was changed or not issued by LLYVerse)' };
  let payload;
  try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return { valid: false, reason: 'unreadable payload' }; }
  if (payload.v !== 1 || payload.product !== 'ember-pro') return { valid: false, reason: 'not an Ember Pro license', payload };
  const t = now / 1000;
  if (payload.iat && payload.iat > t + 86400) return { valid: false, reason: 'license is not valid yet (check your clock)', payload };
  if (payload.exp && t > payload.exp + graceDays * 86400) return { valid: false, reason: `license expired on ${new Date(payload.exp * 1000).toISOString().slice(0, 10)}`, payload };
  return { valid: true, payload, expiresSoon: payload.exp && t > payload.exp - 5 * 86400 };
}
