#!/usr/bin/env node
/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Make a new Ed25519 signing key for Ember Pro licenses.
//   node scripts/pro-keygen.mjs ~/.llyverse/ember-pro-signing.pem
// The PRIVATE key is written to the path you give (mode 600) and must never be committed.
// Put the printed PUBLIC key into src/pro-public-key.js. Old licenses stop working when you rotate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) { console.error('Usage: node scripts/pro-keygen.mjs <private-key-path outside the repo>'); process.exit(1); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abs = path.resolve(out.replace(/^~(?=\/)/, process.env.HOME || '~'));
if (abs === repo || abs.startsWith(repo + path.sep)) { console.error('Refusing to write a private key inside the repository.'); process.exit(1); }
if (fs.existsSync(abs)) { console.error(`${abs} already exists; refusing to overwrite.`); process.exit(1); }
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
fs.writeFileSync(abs, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
console.log(`Private key written to ${abs} (keep it secret; store it as a server secret for license issuing).`);
console.log('Public key for src/pro-public-key.js:\n');
console.log(publicKey.export({ type: 'spki', format: 'pem' }));
