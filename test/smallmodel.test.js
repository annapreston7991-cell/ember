/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// v0.2.1 regressions for "Ember is not writing files" with small models (outputs captured from
// real qwen2.5-coder:1.5b / 3b runs), approvals, paths, Ollama errors, debug log, extras and low-memory mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { mockOllama, quietUI as quietUI0, tmpdir, call } from './helpers.js';

// Close every test UI at the end so open readline interfaces don't keep the runner alive.
const uis = [];
const quietUI = (...a) => { const q = quietUI0(...a); uis.push(q.ui); return q; };
test.after(() => { for (const u of uis) { u.close(); u.input.end?.(); } });

process.env.EMBER_HOME = tmpdir('ember-home-');
const { parseToolCalls, parseLenient } = await import('../src/parser.js');
const { extractCodeFiles, wantsFiles, hasUnsavedCode } = await import('../src/rescue.js');
const { Agent, modelSizeB } = await import('../src/agent.js');
const { OllamaClient, ollamaError, waitForServer, oomAdvice } = await import('../src/ollama.js');
const { DEFAULTS } = await import('../src/config.js');
const { TOOL_DEFS, writeFile, normalizeArgs, coerceContent } = await import('../src/tools.js');
const { resolveInside } = await import('../src/safety.js');
const { UI } = await import('../src/ui.js');
const { enableDebug, debugFile, dlog, redact } = await import('../src/debug.js');
const models = await import('../src/models.js');
const { pickModel } = await import('../src/hardware.js');

const NAMES = TOOL_DEFS.map((t) => t.function.name);

// ---- real model outputs (from this box, Oct 2026) ----
const REAL_15B_FENCED = '```json\n{\n  "name": "write_file",\n  "arguments": {\n    "path": "hello.py",\n    "content": "print(\'Hello, world!\')"\n  }\n}\n```';
const REAL_15B_NO_CLOSE = '{"name": "write_file", "arguments": {"path": "server.js", "content": "const express = require(\'express\');\\nconst app = express();\\napp.listen(3000);"}';
const REAL_3B_OPEN_STRING = '```json\n{\n  "name": "write_file",\n  "arguments": {\n    "path": "todo.py",\n    "content": "import json\\n\\ndef list_todos():\\n    print(\'x\')\n  }\n}\n```';
const REAL_15B_CHAT = 'To create a file `hello.py` that prints "Hello, world!" and a function `add(a, b)`, follow these steps:\n\n1. Open a text editor and create a new file named `hello.py`.\n2. Add the following content to the file:\n\n```python\n# hello.py\ndef add(a, b):\n    return a + b\n\nprint("Hello, world!")\n```\n\n3. Save the file.\n\n4. Run it:\n\n```json\n{"tool": "run_command", "arguments": {"command": "python hello.py", "timeout_sec": 10}}\n```';

test('parser: real small-model tool calls (fenced, missing brace, unterminated string)', () => {
  assert.deepEqual(parseToolCalls(REAL_15B_FENCED, NAMES).calls, [{ name: 'write_file', arguments: { path: 'hello.py', content: "print('Hello, world!')" } }]);
  const a = parseToolCalls(REAL_15B_NO_CLOSE, NAMES).calls[0];
  assert.equal(a.name, 'write_file'); assert.equal(a.arguments.path, 'server.js'); assert.match(a.arguments.content, /app\.listen\(3000\);$/);
  const b = parseToolCalls(REAL_3B_OPEN_STRING, NAMES).calls[0];
  assert.equal(b.arguments.path, 'todo.py'); assert.match(b.arguments.content, /print\('x'\)$/);
});

test('parser: raw newlines in strings, trailing commas, tags, function-call style, flat args', () => {
  assert.equal(parseLenient('{"a": "x\ny", "b": [1,2,],}').a, 'x\ny');
  const raw = '{"name": "write_file", "arguments": {"path": "a.py", "content": "def f():\n    return 1\n"}}';
  assert.equal(parseToolCalls(raw, NAMES).calls[0].arguments.content, 'def f():\n    return 1\n');
  assert.deepEqual(parseToolCalls('<tool_call>\n{"name": "read_file", "arguments": {"path": "a.js"}}\n</tool_call>', NAMES).calls, [{ name: 'read_file', arguments: { path: 'a.js' } }]);
  assert.deepEqual(parseToolCalls('<function=list_dir>{"path": "."}</function>', NAMES).calls, [{ name: 'list_dir', arguments: { path: '.' } }]);
  const fnStyle = parseToolCalls('I will create it.\nwrite_file(path="hi.py", content="""\nprint("hi")\n""")', NAMES, TOOL_DEFS);
  assert.deepEqual(fnStyle.calls, [{ name: 'write_file', arguments: { path: 'hi.py', content: 'print("hi")\n' } }]);
  assert.equal(fnStyle.style, 'function');
  assert.deepEqual(parseToolCalls('write_file("a.txt", "hello")', NAMES, TOOL_DEFS).calls[0].arguments, { path: 'a.txt', content: 'hello' });
  assert.deepEqual(parseToolCalls('{"tool": "write_file", "path": "x.md", "content": "# x"}', NAMES).calls[0].arguments, { path: 'x.md', content: '# x' });
  assert.deepEqual(parseToolCalls('{"name": "run_command", "parameters": {"command": "ls"}}', NAMES).calls[0].arguments, { command: 'ls' });
  assert.equal(parseToolCalls('[{"name":"read_file","arguments":{"path":"a"}},{"name":"read_file","arguments":{"path":"b"}}]', NAMES).calls.length, 2);
  assert.equal(parseToolCalls('You can call `read_file` to read it.', NAMES, TOOL_DEFS).calls.length, 0);
});

test('tools: argument aliases and content as a list of lines / object', () => {
  assert.deepEqual(normalizeArgs('write_file', { file_path: 'a.py', code: 'x' }), { path: 'a.py', content: 'x' });
  assert.deepEqual(normalizeArgs('edit_file', { filename: 'a', old: '1', new: '2' }), { path: 'a', search: '1', replace: '2' });
  assert.equal(coerceContent(['a', 'b']), 'a\nb\n');
  assert.equal(coerceContent({ name: 'x' }), '{\n  "name": "x"\n}\n');
  assert.throws(() => coerceContent(undefined, 'a.py'), /full text of a\.py/);
});

test('rescue: finds the file each pasted code block is for', () => {
  assert.deepEqual(extractCodeFiles(REAL_15B_CHAT, 'Create a file hello.py').map((f) => [f.path, f.reason]), [['hello.py', 'comment']]);
  const two = extractCodeFiles('**index.html**\n```html\n<html></html>\n```\nAnd `style.css`:\n```css\nbody { color: red; }\n```\nRun it:\n```bash\nopen index.html\n```', 'make a page');
  assert.deepEqual(two.map((f) => f.path), ['index.html', 'style.css']);
  assert.deepEqual(extractCodeFiles('Here you go:\n```javascript\nconst x = 1;\nconsole.log(x);\n```', 'create server.js').map((f) => f.path), ['server.js']);
  assert.deepEqual(extractCodeFiles('```python app.py\nprint(1)\n```', 'x').map((f) => f.path), ['app.py']);
  assert.deepEqual(extractCodeFiles('Install it:\n```bash\nnpm install express\n```', 'create server.js'), []);
  assert.deepEqual(extractCodeFiles('Save as backup.sh:\n```bash\n#!/bin/bash\ncp -r notes "backup-$(date +%F)"\n```', 'I need a bash script backup.sh').map((f) => f.path), ['backup.sh']);
  assert.equal(wantsFiles('what does app.js do?'), false);
  assert.equal(wantsFiles('I need a bash script backup.sh'), true);
  assert.equal(hasUnsavedCode('```js\nconst a = 1;\nconst b = 2;\n```'), true);
  assert.equal(hasUnsavedCode('```bash\nnpm test\n```'), false);
});

function agentFor(url, root, ui, extra = {}) {
  const cfg = { ...structuredClone(DEFAULTS), host: url, model: 'mock:1.5b', memory: { enabled: false }, selfFix: { enabled: false }, git: { checkpoints: false }, index: { enabled: false }, steps: { enabled: false }, ...extra };
  return new Agent({ cfg, root, ui, client: new OllamaClient(url) });
}

test('agent: code pasted in chat → "Save this code to hello.py?" → saved on yes, not on no', async () => {
  for (const answer of ['y', 'n']) {
    const answers = answer === 'n' ? ['n', ''] : ['y'];
    const { server, url } = await mockOllama({ models: ['mock:1.5b'], script: [{ content: REAL_15B_CHAT.split('4. Run it')[0] }] });
    const root = tmpdir();
    const { ui, text } = quietUI(answers);
    const agent = agentFor(url, root, ui);
    await agent.init();
    await agent.run('Create a file hello.py that prints "Hello, world!"');
    server.close();
    assert.match(text(), /wrote code for hello\.py in its reply/);
    assert.match(text(), /Save this code to hello\.py\?/);
    assert.equal(fs.existsSync(path.join(root, 'hello.py')), answer === 'y');
    if (answer === 'y') assert.match(fs.readFileSync(path.join(root, 'hello.py'), 'utf8'), /def add/);
  }
});

test('agent: pasted code plus run_command → the file is offered before the command runs', async () => {
  const { server, url } = await mockOllama({ tools: false, models: ['mock:1.5b'], script: [{ content: REAL_15B_CHAT }, { content: 'Done.' }] });
  const root = tmpdir();
  const { ui, text } = quietUI(['y', 'n', '']);
  const agent = agentFor(url, root, ui);
  await agent.init();
  await agent.run('Create a file hello.py with add(a, b)');
  server.close();
  assert.ok(fs.existsSync(path.join(root, 'hello.py')));
  assert.ok(text().indexOf('Save this code to hello.py') < text().indexOf('Run this command?'));
});

test('agent: unnamed code → one nudge → the model calls write_file', async () => {
  const { server, url, requests } = await mockOllama({ models: ['mock:1.5b'], script: [{ content: 'Here:\n```js\nconst a = 1;\nconsole.log(a);\n```' }, call('write_file', { path: 'a.js', content: 'const a = 1;\nconsole.log(a);\n' }), { content: 'Saved a.js.' }] });
  const root = tmpdir();
  const { ui, text } = quietUI(['y']);
  const agent = agentFor(url, root, ui);
  await agent.init();
  const out = await agent.run('write a script that logs a number');
  server.close();
  assert.equal(out, 'Saved a.js.');
  assert.ok(fs.existsSync(path.join(root, 'a.js')));
  assert.match(requests[1].messages.at(-1).content, /did not save it/);
  assert.match(text(), /asking it to use write_file/);
});

test('agent: native-mode model with a truncated JSON call in content still writes the file', async () => {
  const { server, url } = await mockOllama({ models: ['mock:1.5b'], script: [{ content: REAL_15B_NO_CLOSE }, { content: 'Created server.js' }] });
  const root = tmpdir();
  const { ui } = quietUI([], { yes: true });
  const agent = agentFor(url, root, ui);
  await agent.init();
  await agent.run('create server.js with express');
  server.close();
  assert.match(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), /express/);
});

test('agent: text held back as a possible tool call is shown when it is not one', async () => {
  const reply = 'Config:\n```json\n{"port": 3000}\n```';
  const { server, url } = await mockOllama({ models: ['mock:1.5b'], script: [{ content: reply }] });
  const { ui, text } = quietUI([], { yes: true });
  const agent = agentFor(url, tmpdir(), ui);
  await agent.init();
  await agent.explain('what port does it use?');
  server.close();
  assert.match(text(), /"port": 3000/);
});

test('agent: small models get the short prompt; router keeps coding on the main model', async () => {
  const { server, url, requests } = await mockOllama({ models: ['mock:1.5b', 'fast:0.5b'], script: [{ content: 'ok' }] });
  const { ui } = quietUI([], { yes: true });
  const agent = agentFor(url, tmpdir(), ui, { fastModel: 'fast:0.5b' });
  await agent.init();
  await agent.run('add a file');
  server.close();
  assert.match(requests[0].messages[0].content, /you MUST call write_file/);
  assert.equal(requests[0].model, 'mock:1.5b');
  assert.equal(agent.modelFor('code').model, 'mock:1.5b');
  assert.equal(modelSizeB('qwen2.5-coder:3b'), 3);
  assert.equal(modelSizeB('novaAI:latest', '1.5B'), 1.5);
  assert.equal(modelSizeB('qwen2.5-coder:7b'), 7);
});

test('approvals: stray Enter typed during the answer is dropped; empty answer asks again (terminal)', async () => {
  let out = '';
  const input = new PassThrough(); input.isTTY = true;
  const ui = new UI({ input, output: new Writable({ write(ch, _e, cb) { out += ch; cb(); } }) });
  ui._ensure();
  input.write('\n'); // pressed while the model was still streaming
  await new Promise((r) => setTimeout(r, 10));
  const p = ui.confirm('Apply this change to a.js?');
  setTimeout(() => input.write('\n'), 10);
  setTimeout(() => input.write('y\n'), 30);
  assert.equal(await p, 'y');
  assert.match(out, /please type y or n/);
  ui.close();
});

test('approvals: no stdin left → a loud warning instead of a silent "no"', async () => {
  const { ui, text } = quietUI([]);
  ui._ensure(); ui.input.end();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await ui.confirm('Apply this change to a.js?'), 'n');
  assert.match(text(), /did NOT apply the change.*--yes/s);
});

test('paths: ~/ inside a home-folder project, "/hello.py" means the project, outside still refused', () => {
  const home = fs.realpathSync(tmpdir('ember-fakehome-'));
  const old = process.env.HOME; process.env.HOME = home;
  try {
    assert.equal(resolveInside(home, '~/notes/a.txt'), path.join(home, 'notes', 'a.txt'));
    const proj = path.join(home, 'proj'); fs.mkdirSync(proj);
    assert.equal(resolveInside(proj, '/hello.py'), path.join(proj, 'hello.py'));
    assert.equal(resolveInside(proj, '/src/app.js'), path.join(proj, 'src', 'app.js'));
    assert.throws(() => resolveInside(proj, '/tmp/x.txt'), /outside the project/);
    assert.throws(() => resolveInside(proj, '../x.txt'), /outside the project/);
    assert.throws(() => resolveInside(proj, '~/other.txt'), /outside the project/);
  } finally { process.env.HOME = old; }
});

test('ollama: unreachable → clear message (never a bare "fetch failed"); OOM 500 and crashes are recognized', async () => {
  const dead = new OllamaClient('http://127.0.0.1:9');
  await assert.rejects(dead.chat({ model: 'm', messages: [] }), (e) => e.unreachable && /Can't reach Ollama at http:\/\/127\.0\.0\.1:9/.test(e.message));
  await assert.rejects(dead.listModels(), (e) => e.unreachable);
  const server = http.createServer((req, res) => {
    if (req.url === '/api/chat') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'model requires more system memory (2.4 GiB) than is available (1.1 GiB)' })); }
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const c = new OllamaClient(`http://127.0.0.1:${server.address().port}`);
  await assert.rejects(c.chat({ model: 'qwen2.5-coder:3b', messages: [] }), (e) => e.oom && /could not load qwen2\.5-coder:3b/.test(e.message));
  server.close();
  const crash = ollamaError(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } }), 'http://x', { model: 'm', phase: 'stream' });
  assert.ok(crash.oom && crash.crashed);
  assert.match(oomAdvice({ model: 'qwen2.5-coder:3b', ramGB: 3, running: [{ name: 'novaAI:latest' }] }), /ollama stop novaAI:latest[\s\S]*qwen2\.5-coder:1\.5b/);
});

test('ollama: waitForServer backs off 250 ms → 2 s; agent asks before starting Ollama', async () => {
  const waits = [];
  let n = 0;
  const fake = { version: async () => (++n >= 4 ? '1' : null) };
  assert.equal(await waitForServer(fake, { timeoutMs: 60000, sleep: async (ms) => { waits.push(ms); } }), true);
  assert.deepEqual(waits, [250, 500, 1000]);
  const { ui, text } = quietUI(['n']);
  const agent = agentFor('http://127.0.0.1:9', tmpdir(), ui);
  agent.native = true;
  await assert.rejects(agent.run('hi'), (e) => e.friendly && /Can't reach Ollama/.test(e.message));
  if (/Start Ollama now/.test(text())) assert.match(text(), /Start it yourself with/);
  else assert.match(text(), /isn't installed|Can't reach/);
});

test('debug log: raw replies and parse decisions go to ~/.ember/logs, secrets redacted', async () => {
  const f = enableDebug();
  assert.ok(f.startsWith(path.join(process.env.EMBER_HOME, 'logs')));
  const { server, url } = await mockOllama({ models: ['mock:1.5b'], script: [{ content: REAL_15B_FENCED }, { content: 'done' }] });
  const { ui } = quietUI([], { yes: true });
  const agent = agentFor(url, tmpdir(), ui);
  await agent.init();
  await agent.run('create hello.py');
  server.close();
  dlog('start', { cfg: { providers: { grok: { apiKey: 'xai-abcdefghijklmnopqrstuvwxyz' } } } });
  const log = fs.readFileSync(debugFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.event === 'reply' && e.content.includes('write_file')));
  assert.ok(log.some((e) => e.event === 'parse' && e.textCalls?.includes('write_file') && e.style === 'json'));
  assert.ok(log.some((e) => e.event === 'tool' && /Created hello\.py/.test(e.result)));
  assert.ok(!fs.readFileSync(debugFile(), 'utf8').includes('abcdefghijklmnop'));
  assert.equal(redact({ licenseKey: 'EMBER-PRO-x' }).licenseKey, '[redacted]');
});

test('extras: offered once with exact pull commands; low-memory skips the heavy vision model', async () => {
  const { server, url } = await mockOllama({ models: ['qwen2.5-coder:3b'] });
  const client = new OllamaClient(url);
  const cfg = { ...structuredClone(DEFAULTS), model: 'qwen2.5-coder:3b', lowMemory: true };
  const missing = await models.missingOptional(client, cfg);
  assert.deepEqual(missing.map((x) => x.model), ['nomic-embed-text', 'qwen2.5vl:3b']);
  const pulled = [];
  const { ui, text } = quietUI(['y']);
  await models.offerExtras({ ui, client, cfg, pull: async (m) => { pulled.push(m); } });
  assert.deepEqual(pulled, ['nomic-embed-text']);
  assert.match(text(), /qwen2\.5vl:3b .*skipped on this low-memory machine.*ollama pull qwen2\.5vl:3b/);
  const big = { ...structuredClone(DEFAULTS), model: 'qwen2.5-coder:7b', lowMemory: false };
  assert.deepEqual((await models.missingOptional(client, big)).map((x) => x.key), ['embed', 'vision', 'fast']);
  const { ui: ui2, text: t2 } = quietUI([]);
  await models.offerExtras({ ui: ui2, client, cfg: big, interactive: false, pull: async () => { throw new Error('no'); } });
  assert.match(t2(), /ollama pull nomic-embed-text/);
  server.close();
});

test('models: reuse an installed coder model, warn about 1.5b and other loaded models, low-memory mode', () => {
  const inst = [{ name: 'qwen2.5-coder:1.5b' }, { name: 'novaAI:latest' }, { name: 'qwen2.5:1.5b' }];
  assert.equal(models.reusableModel(inst, 'qwen2.5-coder:3b'), 'qwen2.5-coder:1.5b');
  assert.equal(models.reusableModel([...inst, { name: 'qwen2.5-coder:3b' }], 'qwen2.5-coder:3b'), 'qwen2.5-coder:3b');
  assert.equal(models.reusableModel([{ name: 'novaAI:latest' }], 'qwen2.5-coder:3b'), null);
  const w = models.modelWarnings({ model: 'qwen2.5-coder:1.5b', ramGB: 3, running: [{ name: 'novaAI:latest', size: 1.1e9 }] });
  assert.ok(w.some((x) => /very small/.test(x) && /qwen2\.5-coder:3b/.test(x)));
  assert.ok(w.some((x) => /ollama stop novaAI:latest/.test(x)));
  const cfg = { ...structuredClone(DEFAULTS), fastModel: 'qwen2.5-coder:1.5b' };
  assert.equal(models.isLowMemory({}, 3), true);
  assert.equal(models.isLowMemory({}, 16), false);
  cfg.lowMemory = true;
  assert.equal(models.applyLowMemory(cfg), true);
  assert.equal(cfg.fastModel, null); assert.equal(cfg.team.enabled, false); assert.equal(cfg.keepAlive, '10m');
  assert.equal(pickModel({ ramGB: 4 }), 'qwen2.5-coder:3b');
  assert.equal(pickModel({ ramGB: 6 }), 'qwen2.5-coder:3b');
  assert.equal(pickModel({ ramGB: 3 }), 'qwen2.5-coder:1.5b');
});

test('agent: Python saved as todo.json (seen with real 1.5b) goes to the todo.py that was asked for', async () => {
  const root = tmpdir();
  const PY = "import json\n\ndef add(item):\n    pass\n";
  const { server, url } = await mockOllama({ models: ['mock:1.5b'], script: [call('write_file', { path: 'todo.json', content: PY }), { content: 'Done.' }] });
  const { ui, text } = quietUI(['y']);
  const agent = agentFor(url, root, ui);
  await agent.init();
  await agent.run('write a python script todo.py that keeps a todo list in a json file');
  server.close();
  assert.equal(fs.readFileSync(path.join(root, 'todo.py'), 'utf8'), PY);
  assert.ok(!fs.existsSync(path.join(root, 'todo.json')));
  assert.match(text(), /saving it as todo\.py/);
  // A real JSON file is left alone.
  const root2 = tmpdir();
  const m2 = await mockOllama({ models: ['mock:1.5b'], script: [call('write_file', { path: 'todo.json', content: '[]' }), { content: 'Done.' }] });
  const q2 = quietUI(['y']);
  const a2 = agentFor(m2.url, root2, q2.ui);
  await a2.init();
  await a2.run('write a python script todo.py that keeps a todo list in a json file');
  m2.server.close();
  assert.ok(fs.existsSync(path.join(root2, 'todo.json')));
});
