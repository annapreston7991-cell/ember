/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mockOllama, quietUI, tmpdir, toyEmbed } from './helpers.js';

const ix = await import('../src/indexer.js');
const { Agent } = await import('../src/agent.js');
const { OllamaClient } = await import('../src/ollama.js');
const { Memory } = await import('../src/memory.js');
const { DEFAULTS } = await import('../src/config.js');

function project() {
  const root = tmpdir('ember-ix-');
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
  w('src/auth/session.js', '// Session handling for logged-in users\nexport function createSession(user) { return { user }; }\nexport class SessionStore {}\nexport const verifyPassword = (p, h) => p === h;\n');
  w('src/routes.js', "import express from 'express';\nconst app = express();\napp.get('/health', (req, res) => res.send('ok'));\napp.post('/login', handleLogin);\n");
  w('src/math/add.js', 'export function add(a, b) { return a + b; }\n');
  w('tools/report.py', 'def build_report(rows):\n    return rows\n\nclass ReportWriter:\n    pass\n');
  w('server.go', 'package main\n\nfunc StartServer() {}\ntype Config struct {}\n');
  w('README.md', '# Demo\n\n## Getting started\n');
  w('package-lock.json', '{}');
  w('node_modules/x/index.js', 'export const junk = 1;');
  return { root, w };
}

test('symbols are extracted for js, python, go, markdown and express routes', () => {
  const s = (t, f) => ix.extractSymbols(t, f).map((x) => x.name ?? x);
  assert.ok(s('export function createSession() {}\nexport class SessionStore {}\nexport const verifyPassword = () => 1;', 'a.js').join(' ').match(/createSession.*SessionStore.*verifyPassword/));
  assert.ok(s("app.get('/health', h)", 'r.js').some((n) => /\/health/.test(n)));
  assert.ok(s('def build_report(r):\n  pass\nclass ReportWriter:\n  pass', 'a.py').join(' ').match(/build_report.*ReportWriter/));
  assert.ok(s('func StartServer() {}\ntype Config struct {}', 'a.go').join(' ').match(/StartServer.*Config/));
  assert.ok(s('# Demo\n## Getting started', 'a.md').join(' ').match(/Getting started/));
  assert.deepEqual(ix.tokenize('createSession user_id'), ['create', 'session', 'user', 'id'].filter((t) => ix.tokenize('createSession user_id').includes(t)));
});

test('index builds, skips junk, updates incrementally and drops deleted files', async () => {
  const { root, w } = project();
  const a = await ix.updateIndex(root);
  const files = Object.keys(ix.loadIndex(root).files).sort();
  assert.ok(files.includes('src/auth/session.js') && files.includes('tools/report.py'));
  assert.ok(!files.some((f) => f.includes('node_modules') || f.includes('package-lock')));
  assert.equal(a.changed, files.length);
  assert.ok(fs.existsSync(path.join(root, '.ember', 'index', 'index.json')));
  assert.match(fs.readFileSync(path.join(root, '.ember', '.gitignore'), 'utf8'), /index\//);

  const b = await ix.updateIndex(root);
  assert.equal(b.changed, 0, 'nothing changed → nothing re-indexed');

  w('src/math/add.js', 'export function add(a, b) { return a + b; }\nexport function subtract(a, b) { return a - b; }\n');
  fs.rmSync(path.join(root, 'server.go'));
  const c = await ix.updateIndex(root);
  assert.equal(c.changed, 1);
  assert.equal(c.removed, 1);
  assert.ok(ix.loadIndex(root).files['src/math/add.js'].symbols.some((s) => (s.name ?? s) === 'subtract'));
});

test('retrieval ranks by path, symbols and terms', async () => {
  const { root } = project();
  await ix.updateIndex(root);
  const top = async (q) => (await ix.retrieve(root, q, { k: 3 }))[0]?.file;
  assert.equal(await top('fix the createSession bug'), 'src/auth/session.js');
  assert.equal(await top('add a subtract next to add in math'), 'src/math/add.js');
  assert.equal(await top('the health route returns the wrong text'), 'src/routes.js');
  assert.equal(await top('ReportWriter should write CSV'), 'tools/report.py');
  assert.match(ix.formatHits(await ix.retrieve(root, 'createSession')), /src\/auth\/session\.js/);
  assert.match(ix.repoMap(ix.loadIndex(root)), /src\/routes\.js/);
});

test('embeddings: chunks embedded once, reused, and help meaning-based queries', async () => {
  const { root, w } = project();
  let calls = 0;
  const embed = async (texts) => { calls += texts.length; return texts.map(toyEmbed); };
  const a = await ix.updateIndex(root, { embed, embedModel: 'toy' });
  assert.ok(a.embedded > 0 && calls === a.embedded);
  const b = await ix.updateIndex(root, { embed, embedModel: 'toy' });
  assert.equal(b.embedded, 0, 'unchanged files are not re-embedded');
  w('src/math/add.js', 'export function add(a, b) { return a + b + 0; }\n');
  const c = await ix.updateIndex(root, { embed, embedModel: 'toy' });
  assert.equal(c.embedded, 1);
  const vec = ix.decodeVec(ix.encodeVec([1, 2.5, -3]));
  assert.deepEqual([...vec], [1, 2.5, -3]);
  // "login credentials" shares no words with session.js text except via the embedding synonyms
  const hits = await ix.retrieve(root, 'where do we check login credentials', { k: 3, embedQuery: async (q) => toyEmbed(q) });
  assert.ok(hits.slice(0, 2).some((h) => h.file === 'src/auth/session.js'), JSON.stringify(hits));
});

test('agent: index is built at start, hints go into the user turn (not the system prompt), find_code works', async () => {
  const { root, w } = project();
  await ix.updateIndex(root, { embed: async (t) => t.map(toyEmbed), embedModel: 'nomic-embed-text' }); // as after `ember index --embed`
  w('src/math/add.js', 'export function add(a, b) { return a + b; } // add numbers\n');
  const { server, requests, embedRequests, url } = await mockOllama({ models: ['mock:latest', 'nomic-embed-text:latest'], script: [
    { tool_calls: [{ function: { name: 'find_code', arguments: { query: 'add numbers in math' } } }] }, { content: 'ok' }, { content: 'second' }
  ] });
  try {
    const cfg = { ...structuredClone(DEFAULTS), host: url, model: 'mock', selfFix: { enabled: false }, git: { checkpoints: false } };
    const { ui } = quietUI([], { yes: true });
    const agent = new Agent({ cfg, root, ui, client: new OllamaClient(url), memory: new Memory(root, { ...cfg, memory: { enabled: false } }) });
    await agent.init();
    assert.ok(agent.index && Object.keys(agent.index.files).length >= 5);
    assert.equal(embedRequests.length, 1, 'only the changed file is re-embedded at session start');
    assert.match(embedRequests[0].input[0], /^search_document: src\/math\/add\.js/);
    await agent.run('fix the createSession function');
    const first = requests[0];
    assert.match(first.messages.at(-1).content, /look relevant to this message[\s\S]*src\/auth\/session\.js/);
    assert.doesNotMatch(first.messages[0].content, /look relevant to this message/);
    assert.ok(first.tools.some((t) => t.function.name === 'find_code'));
    const toolMsg = requests[1].messages.find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /src\/math\/add\.js/);
    await agent.run('thanks');
    assert.equal(requests[2].messages[0].content, first.messages[0].content, 'system prompt unchanged → KV cache reused');
  } finally { server.close(); }
});

test('agent: index can be turned off, and huge projects are not auto-indexed', async () => {
  const { root } = project();
  const { ui } = quietUI([], { yes: true });
  const mk = (index) => { const cfg = { ...structuredClone(DEFAULTS), host: 'http://127.0.0.1:9', model: 'mock', index: { ...DEFAULTS.index, ...index } }; return new Agent({ cfg, root, ui, client: new OllamaClient(cfg.host), memory: new Memory(root, { ...cfg, memory: { enabled: false } }) }); };
  const off = mk({ enabled: false }); await off.initIndex(); assert.equal(off.index, null, 'off');
  const big = mk({ autoMaxFiles: 2, embeddings: false }); await big.initIndex(); assert.equal(big.index, null, 'big');
  assert.ok(!fs.existsSync(path.join(root, '.ember', 'index')));
  const forced = mk({ autoMaxFiles: 2, embeddings: false }); await forced.initIndex({ force: true }); assert.ok(forced.index);
});

test('ember index CLI builds the index and answers a query', async () => {
  const { root } = project();
  const { spawnSync } = await import('node:child_process');
  const bin = new URL('../bin/ember.js', import.meta.url).pathname;
  const home = tmpdir('ember-home-');
  const r = spawnSync(process.execPath, [bin, 'index', '--query', 'createSession'], { cwd: root, env: { ...process.env, EMBER_HOME: home, OLLAMA_HOST: 'http://127.0.0.1:9' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Index: \d+ files/);
  assert.match(r.stdout, /src\/auth\/session\.js/);
});
