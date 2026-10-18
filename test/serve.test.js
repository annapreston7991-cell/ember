/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mockOllama, tmpdir, call } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { EmberClient } = createRequire(import.meta.url)('../extension/rpc.js');
const BIN = path.join(here, '..', 'bin', 'ember.js');

async function start(script, cfgExtra = {}) {
  const mock = await mockOllama({ script });
  const home = tmpdir('ember-home-');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'mock', host: mock.url, fastModel: null, memory: { enabled: false }, selfFix: { enabled: false }, index: { enabled: false }, git: { checkpoints: false }, ...cfgExtra }), { mode: 0o600 });
  const root = tmpdir('ember-proj-');
  const client = new EmberClient({ command: process.execPath, args: [BIN, 'serve', '-C', root], cwd: root, env: { ...process.env, EMBER_HOME: home } });
  const notes = [];
  const garbage = [];
  client.on('notification', (m, p) => notes.push([m, p]));
  client.on('garbage', (l) => garbage.push(l));
  client.start();
  return { client, root, mock, notes, garbage, close: async () => { await client.stop(); mock.server.close(); } };
}

test('ember serve: initialize, chat with an approved change, streaming, plan notification', async () => {
  const s = await start([call('write_file', { path: 'hello.txt', content: 'hi\n' }), { content: 'Created hello.txt.' }]);
  try {
    const approvals = [];
    s.client.onRequest('approval', async (p) => { approvals.push(p); return { answer: 'y' }; });
    const info = await s.client.request('initialize', {});
    assert.equal(info.model, 'mock');
    assert.equal(info.ready, true);
    assert.equal(fs.realpathSync(info.root), fs.realpathSync(s.root));
    assert.ok(info.features.approvals);
    const r = await s.client.request('chat', { text: 'make hello.txt' });
    assert.equal(r.text, 'Created hello.txt.');
    assert.equal(fs.readFileSync(path.join(s.root, 'hello.txt'), 'utf8'), 'hi\n');
    assert.equal(approvals.length, 1);
    assert.deepEqual({ kind: approvals[0].kind, path: approvals[0].path, before: approvals[0].before, after: approvals[0].after }, { kind: 'change', path: 'hello.txt', before: null, after: 'hi\n' });
    assert.ok(s.notes.some(([m, p]) => m === 'stream' && /Created hello/.test(p.text)));
    assert.ok(s.notes.some(([m, p]) => m === 'busy' && p.busy === true));
    assert.ok(s.notes.some(([m]) => m === 'plan'));
    assert.ok(s.notes.every(([, p]) => !/\x1b\[/.test(JSON.stringify(p))), 'no ANSI colors in protocol messages');
    const u = await s.client.request('undo');
    assert.match(u.text, /hello\.txt/);
    assert.ok(!fs.existsSync(path.join(s.root, 'hello.txt')));
    assert.deepEqual(s.garbage, [], 'stdout carries only JSON-RPC');
  } finally { await s.close(); }
});

test('ember serve: rejected change with feedback, commands ask the editor, dangerous needs "yes"', async () => {
  const s = await start([
    call('write_file', { path: 'a.txt', content: 'x' }), { content: 'ok, not writing' },
    call('run_command', { command: 'echo served' }), { content: 'ran it' },
    call('run_command', { command: 'rm -rf build' }), { content: 'blocked' }
  ]);
  try {
    const seen = [];
    s.client.onRequest('approval', async (p) => { seen.push(p.kind); return p.kind === 'danger' ? { answer: 'no' } : p.kind === 'change' ? { answer: 'n' } : { answer: 'y' }; });
    s.client.onRequest('input', async (p) => { seen.push(`input:${p.prompt.trim().slice(0, 12)}`); return { text: 'use a.md instead' }; });
    await s.client.request('initialize', {});
    await s.client.request('chat', { text: 'write a.txt' });
    assert.ok(!fs.existsSync(path.join(s.root, 'a.txt')));
    const toolMsg = s.mock.requests[1].messages.find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /rejected[\s\S]*use a\.md instead/);
    await s.client.request('chat', { text: 'run echo' });
    assert.match(s.mock.requests[3].messages.at(-1).content, /served/);
    await s.client.request('chat', { text: 'clean' });
    assert.match(s.mock.requests[5].messages.at(-1).content, /blocked this destructive command/);
    assert.deepEqual(seen.filter((k) => !k.startsWith('input')), ['change', 'confirm', 'danger']);
  } finally { await s.close(); }
});

test('ember serve: explain a selection (read-only), busy guard, errors, unknown methods', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await start([{ content: 'It adds two numbers.' }]);
  try {
    await s.client.request('initialize', {});
    const r = await s.client.request('explain', { file: 'math.js', selection: 'const add = (a, b) => a + b;', language: 'javascript', startLine: 3 });
    assert.equal(r.text, 'It adds two numbers.');
    const sent = s.mock.requests[0];
    assert.match(sent.messages.at(-1).content, /math\.js \(from line 3\)[\s\S]*const add/);
    assert.ok(!sent.tools.some((t) => ['write_file', 'edit_file', 'run_command'].includes(t.function.name)));
    await assert.rejects(s.client.request('nope'), /Unknown method/);
    await assert.rejects(s.client.request('chat', {}), /text is required/);
    const st = await s.client.request('status');
    assert.equal(st.busy, false);
    release();
  } finally { await gate; await s.close(); }
});

test('ember serve: a missing model is reported, not crashed on', async () => {
  const s = await start([], { model: 'not-installed' });
  try {
    const info = await s.client.request('initialize', {});
    assert.equal(info.ready, false);
    assert.match(info.problem, /not-installed is not available[\s\S]*ember setup/);
    await assert.rejects(s.client.request('chat', { text: 'hi' }), /ember setup/);
  } finally { await s.close(); }
});

test('extension manifest: every contributed command is registered, files exist, code parses', async () => {
  const ext = path.join(here, '..', 'extension');
  const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
  const src = fs.readFileSync(path.join(ext, 'extension.js'), 'utf8');
  for (const c of pkg.contributes.commands) assert.match(src, new RegExp(`registerCommand\\('${c.command.replace('.', '\\.')}'`), c.command);
  assert.match(src, /registerWebviewViewProvider\('ember\.chat'/);
  for (const f of [pkg.main, pkg.icon, 'media/chat.js', 'media/chat.css', 'media/flame.svg', 'LICENSE', 'README.md']) assert.ok(fs.existsSync(path.join(ext, f)), f);
  const { spawnSync } = await import('node:child_process');
  for (const f of ['extension.js', 'rpc.js', 'media/chat.js']) assert.equal(spawnSync(process.execPath, ['--check', path.join(ext, f)]).status, 0, f);
  assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version);
  assert.doesNotMatch((fs.readFileSync(path.join(ext, 'README.md'), 'utf8') + JSON.stringify(pkg)).replaceAll('annapreston7991-cell', 'OWNER'), /\bione\b|preston/i);
});
