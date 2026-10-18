/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { quietUI, tmpdir } from './helpers.js';

const pv = await import('../src/preview.js');
const { DEFAULTS } = await import('../src/config.js');

const w = (root, f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };

test('detectDevServer: package scripts, ports, Django, static sites, config override', () => {
  const a = tmpdir(); w(a, 'package.json', JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }));
  assert.deepEqual(pv.detectDevServer(a), { kind: 'script', command: 'npm run dev', script: 'vite', port: 5173 });
  const b = tmpdir(); w(b, 'package.json', JSON.stringify({ scripts: { start: 'node server.js --port 4321' } })); w(b, 'pnpm-lock.yaml', '');
  assert.equal(pv.detectDevServer(b).command, 'pnpm run start');
  assert.equal(pv.detectDevServer(b).port, 4321);
  const c = tmpdir(); w(c, 'manage.py', '');
  assert.equal(pv.detectDevServer(c).kind, 'django');
  const d = tmpdir(); w(d, 'public/index.html', '<h1>hi</h1>');
  assert.equal(pv.detectDevServer(d).kind, 'static');
  assert.equal(pv.detectDevServer(d, { preview: { command: 'make serve', port: 9000 } }).command, 'make serve');
  assert.equal(pv.detectDevServer(tmpdir()), null);
  assert.equal(pv.joinUrl('http://127.0.0.1:5173/', '/about'), 'http://127.0.0.1:5173/about');
  assert.match('  ➜  Local:   http://localhost:5173/\n'.match(pv.URL_RE)[0], /^http:\/\/localhost:5173\/$/);
});

test('static server serves files and refuses to leave its folder', async () => {
  const root = tmpdir(); w(root, 'site/index.html', '<h1>ok</h1>'); w(root, 'secret.txt', 'no');
  const port = await pv.freePort();
  const s = await pv.staticServer(path.join(root, 'site'), port);
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), '<h1>ok</h1>');
    const r = await fetch(`http://127.0.0.1:${port}/..%2Fsecret.txt`);
    assert.notEqual(await r.text(), 'no');
  } finally { s.close(); }
});

test('dev server: asks first, finds the URL in the output, stops cleanly; refusal is respected', async () => {
  const root = tmpdir();
  w(root, 'server.js', "const http = require('http'); const s = http.createServer((q, r) => r.end('<title>Demo</title><h1>Hello</h1>')); s.listen(0, '127.0.0.1', () => console.log('ready on http://localhost:' + s.address().port + '/'));");
  w(root, 'package.json', JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const cfg = structuredClone(DEFAULTS);
  const ctx = { always: { commands: new Set() } };
  const no = quietUI(['n']);
  await assert.rejects(pv.startPreview({ root, ui: no.ui, cfg, ctx }), /not started/);
  const { ui, text } = quietUI(['y']);
  const p = await pv.startPreview({ root, ui, cfg, ctx });
  try {
    assert.match(text(), /Start the dev server with "npm run dev"/);
    assert.match(p.url, /^http:\/\/localhost:\d+\/$/);
    assert.match(await (await fetch(p.url)).text(), /Hello/);
  } finally { await p.stop(); }
  await assert.rejects(fetch(p.url, { signal: AbortSignal.timeout(1500) }));
});

test('dev server that crashes reports its output', async () => {
  const root = tmpdir();
  w(root, 'package.json', JSON.stringify({ scripts: { dev: 'node -e "console.error(\'boom: missing module\'); process.exit(1)"' } }));
  const { ui } = quietUI([], { yes: true });
  await assert.rejects(pv.startPreview({ root, ui, cfg: structuredClone(DEFAULTS), ctx: { always: { commands: new Set() } }, timeoutMs: 8000 }), /did not come up[\s\S]*boom/);
});

const chrome = pv.findChrome();

test('screenshot with the system browser catches console errors, and previewOnce feeds the vision model', { skip: !chrome && 'no Chrome/Chromium on this machine' }, async () => {
  const root = tmpdir();
  w(root, 'index.html', '<!doctype html><title>Shop</title><body style="background:#fff"><h1>Cart</h1><script>console.error("Cannot read properties of undefined (reading \'price\')")</script></body>');
  const { ui } = quietUI([], { yes: true });
  const agent = { root, ctx: { always: { commands: new Set() } }, extraTools: [], ui, preview: null };
  const seen = [];
  try {
    const r = await pv.previewOnce({ agent, ui, cfg: structuredClone(DEFAULTS), question: 'is the cart right?', describe: async (p, q) => { seen.push([p, q]); return 'A white page with the heading "Cart".'; }, ensureVision: async () => true });
    assert.ok(fs.existsSync(r.shot.path) && fs.statSync(r.shot.path).size > 1000, 'png written');
    assert.equal(fs.readFileSync(r.shot.path).subarray(1, 4).toString(), 'PNG');
    assert.ok(r.shot.path.includes(path.join('.ember', 'cache', 'preview')));
    assert.equal(seen[0][1], 'is the cart right?');
    assert.match(r.report, /Live preview of http:\/\/127\.0\.0\.1:\d+\//);
    assert.match(r.report, /heading "Cart"/);
    assert.match(r.report, /reading 'price'/);
    assert.ok(agent.extraTools.some((t) => t.def.function.name === 'preview_page'), 'agent can re-check the page itself');
    const again = await agent.extraTools.find((t) => t.def.function.name === 'preview_page').run({}, { path: '/' });
    assert.match(again, /Live preview/);
  } finally { await pv.stopPreview(agent); }
  assert.equal(agent.preview, null);
  assert.ok(!agent.extraTools.length);
});

test('the plain Chrome CLI engine (no npm packages) also screenshots and reads console errors', { skip: !chrome && 'no Chrome/Chromium on this machine' }, async () => {
  const root = tmpdir();
  w(root, 'index.html', '<!doctype html><h1>Hi</h1><script>console.error("Uncaught thing is not defined")</script>');
  const port = await pv.freePort();
  const s = await pv.staticServer(root, port);
  try {
    const shot = await pv.screenshot(`http://127.0.0.1:${port}/`, path.join(root, 'out.png'), { engine: { kind: 'chrome', bin: chrome } });
    assert.equal(shot.engine, 'chrome');
    assert.equal(fs.readFileSync(shot.path).subarray(1, 4).toString(), 'PNG');
    assert.ok(shot.console.some((e) => /not defined/.test(e)), JSON.stringify(shot.console));
  } finally { s.close(); }
});

test('no browser and install declined: degrades to an HTTP check', async () => {
  const root = tmpdir(); w(root, 'index.html', '<h1>x</h1>');
  const { ui, text } = quietUI(['n']);
  const agent = { root, ctx: { always: { commands: new Set() } }, extraTools: [], ui, preview: null };
  const saved = process.env.PATH, savedChrome = process.env.EMBER_CHROME;
  const home = process.env.EMBER_HOME; process.env.EMBER_HOME = tmpdir();
  process.env.PATH = '/nonexistent'; delete process.env.EMBER_CHROME;
  try {
    if (pv.findChrome()) return; // a macOS app bundle was found; nothing to test here
    const r = await pv.previewOnce({ agent, ui, cfg: structuredClone(DEFAULTS) });
    assert.equal(r.shot, null);
    assert.match(r.report, /no screenshot[\s\S]*HTTP 200/);
    assert.match(text(), /Install Playwright \+ Chromium/);
  } finally { process.env.PATH = saved; if (savedChrome) process.env.EMBER_CHROME = savedChrome; process.env.EMBER_HOME = home; await pv.stopPreview(agent); }
});
