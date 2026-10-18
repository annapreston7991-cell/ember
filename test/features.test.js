/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mockOllama, quietUI, tmpdir, call } from './helpers.js';

process.env.EMBER_HOME = tmpdir('ember-home-');
const { Agent } = await import('../src/agent.js');
const { OllamaClient } = await import('../src/ollama.js');
const { Memory } = await import('../src/memory.js');
const { DEFAULTS } = await import('../src/config.js');
const { detectChecks } = await import('../src/checks.js');
const { parseModelRef, OpenAICompatClient, providerConfig } = await import('../src/cloud.js');
const { parseDuckDuckGo, htmlToText, webFetch, webSearch } = await import('../src/web.js');
const { loadPlugins, validatePlugin } = await import('../src/plugins.js');
const { findImagePaths, describeImages } = await import('../src/vision.js');
const { scanTree, diffTrees } = await import('../src/watch.js');
const { git } = await import('../src/git.js');
const { explainPrompt } = await import('../src/repl.js');

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ember.js');
const cfgFor = (url, extra = {}) => ({ ...structuredClone(DEFAULTS), host: url, model: 'mock', ...extra });
const agentFor = (root, cfg, ui, client, extraTools) => new Agent({ cfg, root, ui, client: client || new OllamaClient(cfg.host), memory: new Memory(root, { ...cfg, memory: { enabled: false } }), extraTools });

// ---------- self-fix loop ----------

test('detectChecks reads package.json scripts and config overrides', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'tsc', lint: 'eslint .', dev: 'vite' } }));
  assert.deepEqual(detectChecks(root).map((c) => c.command), ['npm run lint', 'npm run build', 'npm test']);
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  assert.equal(detectChecks(root).at(-1).command, 'pnpm test');
  assert.deepEqual(detectChecks(root, { checks: { commands: ['make check'] } }).map((c) => c.command), ['make check']);
  const empty = tmpdir();
  fs.writeFileSync(path.join(empty, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(detectChecks(empty).length, 0);
});

test('self-fix loop: failing test output goes back to the model until it passes', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'math.test.js'), "import test from 'node:test';import assert from 'node:assert';import { add } from './math.js';test('add', () => assert.equal(add(2, 3), 5));\n");
  const { server, requests, url } = await mockOllama({
    script: [
      call('write_file', { path: 'math.js', content: 'export const add = (a, b) => a - b;\n' }), // bug
      { content: 'Wrote math.js.' },
      call('edit_file', { path: 'math.js', search: 'a - b', replace: 'a + b' }),             // fix after seeing failure
      { content: 'Fixed the operator.' }
    ]
  });
  const cfg = cfgFor(url);
  const { ui, text } = quietUI([], { yes: true });
  const agent = agentFor(root, cfg, ui);
  agent.ctx.quietCommands = true;
  await agent.init();
  await agent.runTask('write add()');
  assert.equal(fs.readFileSync(path.join(root, 'math.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
  const fixPrompt = requests[2].messages.filter((m) => m.role === 'user').at(-1).content;
  assert.match(fixPrompt, /npm test.*failed[\s\S]*fix attempt 1 of 3/);
  assert.match(text(), /Checks pass/);
  server.close();
});

test('self-fix loop stops after maxAttempts', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }));
  let n = 0;
  const { server, url } = await mockOllama({ script: () => (n++ % 2 === 0 ? call('write_file', { path: `f${n}.txt`, content: String(n) }) : { content: 'tried' }) });
  const cfg = cfgFor(url, { selfFix: { enabled: true, maxAttempts: 2 } });
  const { ui, text } = quietUI([], { yes: true });
  const agent = agentFor(root, cfg, ui);
  agent.ctx.quietCommands = true;
  await agent.init();
  await agent.runTask('do it');
  assert.match(text(), /still fails after 2 fix attempt/);
  server.close();
});

// ---------- git integration in the agent ----------

test('runTask makes a checkpoint, and commitMessage asks the model', async () => {
  const root = tmpdir();
  git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  const { server, url } = await mockOllama({ script: [call('write_file', { path: 'a.txt', content: 'b' }), { content: 'ok' }, { content: 'Change a.txt to b' }] });
  const { ui } = quietUI([], { yes: true });
  const agent = agentFor(root, cfgFor(url), ui);
  await agent.init();
  await agent.runTask('change a');
  assert.equal(agent.checkpoints.list.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'b');
  agent.checkpoints.restore();
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a');
  assert.equal(await agent.commitMessage('diff'), 'Change a.txt to b');
  server.close();
});

// ---------- explain mode ----------

test('explain mode is read-only', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)');
  const { server, requests, url } = await mockOllama({ script: [call('write_file', { path: 'x.js', content: 'x' }), { content: 'It prints 1.' }] });
  const { ui } = quietUI([], { yes: true });
  const agent = agentFor(root, cfgFor(url), ui);
  await agent.init();
  const out = await agent.explain(explainPrompt('app.js', root));
  assert.equal(out, 'It prints 1.');
  assert.ok(!fs.existsSync(path.join(root, 'x.js')));
  assert.deepEqual(requests[0].tools.map((t) => t.function.name).filter((n) => n !== 'find_code').sort(), ['list_dir', 'read_file', 'search']);
  assert.match(requests[0].messages[0].content, /EXPLAIN mode/);
  assert.match(requests[0].messages.at(-1).content, /Explain the file app\.js[\s\S]*console\.log\(1\)/);
  assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /not available in explain mode/);
  assert.equal(agent.mode, 'agent');
  server.close();
});

// ---------- cloud models ----------

test('cloud model references', () => {
  assert.deepEqual(parseModelRef('cloud:grok-4'), { provider: 'grok', model: 'grok-4' });
  assert.deepEqual(parseModelRef('cloud:openai:gpt-4.1'), { provider: 'openai', model: 'gpt-4.1' });
  assert.deepEqual(parseModelRef('cloud:lab:qwen-72b', { providers: { lab: { baseUrl: 'http://x/v1' } } }), { provider: 'lab', model: 'qwen-72b' });
  assert.equal(parseModelRef('qwen2.5-coder:7b'), null);
  const prev = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'env-key';
  assert.equal(providerConfig('grok', { providers: { grok: { apiKey: 'cfg-key' } } }).apiKey, 'env-key');
  delete process.env.XAI_API_KEY;
  assert.equal(providerConfig('grok', { providers: { grok: { apiKey: 'cfg-key' } } }).apiKey, 'cfg-key');
  if (prev) process.env.XAI_API_KEY = prev;
  assert.throws(() => providerConfig('nope'), /Unknown cloud provider/);
});

function mockOpenAI(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      const r = replies.shift();
      res.setHeader('content-type', 'text/event-stream');
      for (const chunk of r) res.write(`data: ${JSON.stringify({ choices: [{ delta: chunk }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('OpenAI-compatible client streams text and tool calls; agent round-trips tool ids', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  const { server, requests, url } = await mockOpenAI([
    [{ tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'read_file', arguments: '{"pa' } }] }, { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }],
    [{ content: 'The file ' }, { content: 'says hello.' }]
  ]);
  const client = new OpenAICompatClient({ name: 'test', baseUrl: url, apiKey: 'sk-test', label: 'Test' });
  const cfg = cfgFor('http://unused', { model: 'cloud:test:grok-test', providers: { test: { baseUrl: url } } });
  const { ui } = quietUI([], { yes: true });
  const agent = agentFor(root, cfg, ui, client);
  await agent.init();
  assert.equal(agent.model, 'grok-test');
  const out = await agent.run('what does a.txt say?');
  assert.equal(out, 'The file says hello.');
  assert.equal(requests[0].auth, 'Bearer sk-test');
  assert.equal(requests[0].body.model, 'grok-test');
  assert.ok(requests[0].body.tools.length >= 7);
  const msgs = requests[1].body.messages;
  const asst = msgs.find((m) => m.role === 'assistant');
  assert.equal(asst.tool_calls[0].id, 'call_abc');
  assert.equal(asst.tool_calls[0].function.arguments, '{"path":"a.txt"}');
  const tool = msgs.find((m) => m.role === 'tool');
  assert.equal(tool.tool_call_id, 'call_abc');
  assert.match(tool.content, /hello/);
  server.close();
});

test('cloud client refuses to run without a key', async () => {
  const client = new OpenAICompatClient({ name: 'grok', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', apiKeyEnv: 'XAI_API_KEY', label: 'xAI Grok' });
  assert.equal(await client.hasModel(), false);
  await assert.rejects(client.chat({ model: 'grok-4', messages: [] }), /No API key.*XAI_API_KEY/);
});

// ---------- web lookup ----------

test('web: DuckDuckGo HTML parsing, html to text, private hosts blocked', async () => {
  const html = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ftest.html&rut=x">Test runner | <b>Node.js</b></a>
    <a class="result__snippet" href="#">The node:test module facilitates <b>creating</b> tests.</a></div>`;
  const r = parseDuckDuckGo(html);
  assert.deepEqual(r[0], { title: 'Test runner | Node.js', url: 'https://nodejs.org/api/test.html', snippet: 'The node:test module facilitates creating tests.' });
  assert.equal(htmlToText('<p>a &amp; b</p><script>x()</script><p>c</p>'), 'a & b\nc');
  await assert.rejects(webFetch('http://127.0.0.1:8080/'), /Private/);
  await assert.rejects(webFetch('file:///etc/passwd'), /Only http/);
  const fakeFetch = async () => ({ ok: true, text: async () => html, headers: new Map() });
  assert.match(await webSearch('node test', { fetchImpl: fakeFetch }), /1\. Test runner[\s\S]*nodejs\.org/);
});

test('web tools are off by default and ask before use when on', async () => {
  const root = tmpdir();
  const { server, requests, url } = await mockOllama({ script: [{ content: 'hi' }, call('web_search', { query: 'x' }), { content: 'skipped' }] });
  const { ui } = quietUI(['n']);
  const off = agentFor(root, cfgFor(url), ui);
  await off.init();
  await off.run('hello');
  assert.ok(!requests[0].tools.some((t) => t.function.name === 'web_search'));
  const on = agentFor(root, cfgFor(url, { web: { enabled: true } }), ui);
  await on.init();
  await on.run('search');
  assert.ok(requests[1].tools.some((t) => t.function.name === 'web_search'));
  assert.match(requests[2].messages.find((m) => m.role === 'tool').content, /declined web_search/);
  server.close();
});

// ---------- plugins ----------

test('plugins: global load, validation, project trust, pro hook, and agent use', async () => {
  const home = process.env.EMBER_HOME;
  const gdir = path.join(home, 'plugins');
  fs.mkdirSync(gdir, { recursive: true });
  fs.writeFileSync(path.join(gdir, 'shout.mjs'), `export default { name: 'shout', description: 'Uppercase text', readOnly: true,
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async run(args, ember) { return args.text.toUpperCase() + ' @ ' + ember.root.length; } };`);
  fs.writeFileSync(path.join(gdir, 'bad.mjs'), `export default { name: 'read_file', description: 'x', run() {} };`);
  fs.writeFileSync(path.join(gdir, 'fancy.mjs'), `export default { name: 'fancy', description: 'pro only', pro: true, run() {} };`);
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.ember', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ember', 'plugins', 'proj.js'), `export default { name: 'proj_tool', description: 'project tool', run: () => 'ran' };`);
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');

  let asked = 0;
  let r = await loadPlugins({ root, confirmTrust: async () => { asked++; return false; } });
  assert.deepEqual(r.tools.map((t) => t.def.function.name), ['shout']);
  assert.equal(asked, 1);
  assert.ok(r.skipped.some((s) => /built-in/.test(s.reason)));
  assert.ok(r.skipped.some((s) => /Ember Pro/.test(s.reason)));
  assert.ok(r.skipped.some((s) => /not trusted/.test(s.reason)));
  r = await loadPlugins({ root, confirmTrust: async () => true });
  assert.ok(r.tools.some((t) => t.def.function.name === 'proj_tool'));
  r = await loadPlugins({ root, confirmTrust: async () => { throw new Error('should not ask again'); } });
  assert.ok(r.tools.some((t) => t.def.function.name === 'proj_tool'));
  assert.match(validatePlugin({ name: 'x y', description: 'd', run() {} }), /invalid/);

  const { server, requests, url } = await mockOllama({ script: [call('shout', { text: 'hey' }), { content: 'done' }] });
  const { ui } = quietUI([], { yes: true });
  const agent = agentFor(root, cfgFor(url), ui, null, r.tools);
  await agent.init();
  await agent.run('shout hey');
  assert.ok(requests[0].tools.some((t) => t.function.name === 'shout'));
  assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /^HEY @ \d+/);
  server.close();
  fs.rmSync(gdir, { recursive: true, force: true });
});

// ---------- images ----------

test('images: paths in prompts are found and sent to the vision model', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.deepEqual(findImagePaths('the button in ./shot.png is wrong, also missing.png', root), [path.join(root, 'shot.png')]);
  assert.deepEqual(findImagePaths('what does "shot.png" say? also (./shot.png).', root), [path.join(root, 'shot.png')]);
  assert.deepEqual(findImagePaths('What error is in ./shot.png?', root), [path.join(root, 'shot.png')]);
  assert.deepEqual(findImagePaths('no images here', root), []);
  const { server, requests, url } = await mockOllama({ script: [{ content: 'A red button labeled Save.' }] });
  const d = await describeImages({ client: new OllamaClient(url), model: 'qwen2.5vl:3b', paths: [path.join(root, 'shot.png')], question: 'fix it' });
  assert.equal(d, 'A red button labeled Save.');
  assert.equal(requests[0].model, 'qwen2.5vl:3b');
  assert.equal(requests[0].messages[0].images[0], Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  server.close();
});

// ---------- watch ----------

test('watch: tree scanning detects changes, additions and deletions', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.js'), '1');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), '1');
  const t1 = scanTree(root);
  assert.equal(t1.size, 1);
  fs.writeFileSync(path.join(root, 'b.js'), '2');
  fs.utimesSync(path.join(root, 'a.js'), new Date(), new Date(Date.now() + 5000));
  const t2 = scanTree(root);
  assert.deepEqual(diffTrees(t1, t2).map((f) => path.basename(f)).sort(), ['a.js', 'b.js']);
  fs.rmSync(path.join(root, 'b.js'));
  assert.deepEqual(diffTrees(t2, scanTree(root)).map((f) => path.basename(f)), ['b.js']);
});

// ---------- ember new (whole CLI, mocked model) ----------

test('ember new scaffolds a project, then the self-fix loop runs its tests', async () => {
  const cwd = tmpdir('ember-new-');
  const home = tmpdir('ember-newhome-');
  const { server, requests, url } = await mockOllama({
    script: [
      call('write_file', { path: 'package.json', content: '{"name":"greeter","type":"module","scripts":{"start":"node index.js","test":"node --test"}}\n' }),
      call('write_file', { path: 'index.js', content: "export const greet = (n) => `Hi ${n}`;\n" }),
      call('write_file', { path: 'index.test.js', content: "import test from 'node:test';import assert from 'node:assert';import { greet } from './index.js';test('greet', () => assert.equal(greet('A'), 'Hi A'));\n" }),
      { content: 'Built a greeter. Run npm start.' }
    ]
  });
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, 'new', 'a tiny greeter library', '--yes', '--model', 'mock', '--host', url], { cwd, env: { ...process.env, EMBER_HOME: home, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '';
    p.stdout.on('data', (d) => (s += d));
    p.stderr.on('data', (d) => (s += d));
    p.on('close', (code) => resolve({ code, s }));
  });
  server.close();
  assert.equal(out.code, 0, out.s);
  const dir = path.join(cwd, 'a-tiny-greeter-library');
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  assert.ok(fs.existsSync(path.join(dir, 'index.test.js')));
  assert.match(requests[0].messages.at(-1).content, /Create a complete, working new project[\s\S]*tiny greeter/);
  assert.match(out.s, /Checks pass \(npm test\)/);
});

test('the example plugin loads and runs', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.js'), '// TODO: handle errors\nconst x = 1; // FIXME wrong\n');
  fs.mkdirSync(path.join(root, '.ember', 'plugins'), { recursive: true });
  fs.copyFileSync(path.join(path.dirname(BIN), '..', 'examples', 'plugins', 'todo-scan.js'), path.join(root, '.ember', 'plugins', 'todo-scan.mjs'));
  const { tools } = await loadPlugins({ root, confirmTrust: async () => true });
  const t = tools.find((x) => x.def.function.name === 'todo_scan');
  assert.ok(t);
  assert.equal(await t.run({ pluginApi: { root } }, {}), 'a.js:1: TODO handle errors\na.js:2: FIXME wrong');
});
