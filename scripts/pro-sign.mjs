#!/usr/bin/env node
/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Issue an Ember Pro license key (offline-verifiable, Ed25519-signed).
//   EMBER_PRO_SIGNING_KEY=~/.llyverse/ember-pro-signing.pem node scripts/pro-sign.mjs --id sub_123 --days 35 [--seats 1]
// The key holds no personal data: a license id (e.g. a Stripe subscription id), plan, seats, issue/expiry dates.
import fs from 'node:fs';
import { signLicense } from '../src/license.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const keyPath = (opt('key') || process.env.EMBER_PRO_SIGNING_KEY || '').replace(/^~(?=\/)/, process.env.HOME || '~');
if (!keyPath || !fs.existsSync(keyPath)) { console.error('Give the private key with --key <path> or EMBER_PRO_SIGNING_KEY.'); process.exit(1); }
const id = opt('id');
if (!id) { console.error('Usage: pro-sign.mjs --id <license-or-subscription-id> [--days 35] [--seats 1]'); process.exit(1); }
const days = Number(opt('days', '35'));
const key = signLicense({ id, seats: Number(opt('seats', '1')), days }, fs.readFileSync(keyPath, 'utf8'));
console.log(key);
