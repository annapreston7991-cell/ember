/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// End-to-end agent loop against a mocked Ollama server (no model needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable, PassThrough } from 'node:stream';

process.env.EMBER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-home-'));
const { Agent } = await import('../src/agent.js');
const { OllamaClient } = await import('../src/ollama.js');
const { Memory } = await import('../src/memory.js');
const { UI } = await import('../src/ui.js');
const { DEFAULTS } = await import('../src/config.js');
const { undoLast } = await import('../src/tools.js');

function mockOllama({ tools, script }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: 'mock' }));
      if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: tools ? ['completion', 'tools'] : ['completion'] }));
      if (req.url === '/api/chat') {
        requests.push(j);
        const step = script.shift() || { content: 'done' };
        res.setHeader('content-type', 'application/x-ndjson');
        // Stream content in two chunks to exercise the NDJSON reader.
        const content = step.content || '';
        const half = Math.floor(content.length / 2);
        res.write(JSON.stringify({ message: { role: 'assistant', content: content.slice(0, half) }, done: false }) + '\n');
        res.end(JSON.stringify({ message: { role: 'assistant', content: content.slice(half), tool_calls: step.tool_calls }, done: true }) + '\n');
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

function quietUI(answers = []) {
  let out = '';
  const output = new Writable({ write(chunk, _e, cb) { out += chunk; cb(); } });
  const input = new PassThrough();
  const ui = new UI({ yes: answers.length === 0, input, output });
  for (const a of answers) input.write(a + '\n');
  return { ui, text: () => out };
}

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-proj-'));
  fs.writeFileSync(path.join(root, 'index.js'), "console.log('hi');\n");
  fs.writeFileSync(path.join(root, 'EMBER.md'), 'Always write tests with node:test.\n');
  return root;
}

test('native tool calling: reads, edits, runs a command, then answers', async () => {
  const root = project();
  const { server, requests, url } = await mockOllama({
    tools: true,
    script: [
      { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'index.js' } } }] },
      { tool_calls: [{ function: { name: 'edit_file', arguments: { path: 'index.js', search: "'hi'", replace: "'hello'" } } }] },
      { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node index.js' } } }] },
      { content: 'Changed the greeting to hello.' }
    ]
  });
  const cfg = { ...DEFAULTS, host: url, model: 'mock' };
  const { ui, text } = quietUI();
  ui.yes = true;
  const agent = new Agent({ cfg, root, ui, client: new OllamaClient(url), memory: new Memory(root, cfg) });
  agent.ctx.quietCommands = true;
  await agent.init();
  assert.equal(agent.native, true);
  const final = await agent.run('change the greeting');
  assert.equal(final, 'Changed the greeting to hello.');
  assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), "console.log('hello');\n");
  assert.equal(requests.length, 4);
  assert.ok(requests[0].tools.length >= 7, 'tools sent natively');
  assert.match(requests[0].messages[0].content, /EMBER\.md[\s\S]*node:test/);
  const toolMsgs = requests[3].messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 3);
  assert.match(toolMsgs[2].content, /exit code 0[\s\S]*hello/);
  assert.match(text(), /\+console\.log\('hello'\);/); // the diff was shown
  // undo restores the file
  assert.equal(undoLast(agent.ctx).path, 'index.js');
  assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), "console.log('hi');\n");
  server.close();
});

test('JSON fallback mode for models without tool support, with a rejected write', async () => {
  const root = project();
  const { server, requests, url } = await mockOllama({
    tools: false,
    script: [
      { content: 'Creating it.\n{"tool": "write_file", "arguments": {"path": "../escape.txt", "content": "x"}}' },
      { content: '{"tool": "write_file", "arguments": {"path": "util.js", "content": "export const x = 1;\\n"}}' },
      { content: '{"tool": "write_file", "arguments": {"path": "notes.txt", "content": "nope"}}' },
      { content: 'OK, I created util.js and skipped notes.txt.' }
    ]
  });
  const cfg = { ...DEFAULTS, host: url, model: 'mock' };
  // answers: approve util.js, reject notes.txt, then give feedback
  const { ui } = quietUI(['y', 'n', 'not needed']);
  const agent = new Agent({ cfg, root, ui, client: new OllamaClient(url), memory: new Memory(root, cfg) });
  await agent.init();
  assert.equal(agent.native, false);
  const final = await agent.run('make a util');
  assert.equal(final, 'OK, I created util.js and skipped notes.txt.');
  assert.ok(!fs.existsSync(path.join(root, '..', 'escape.txt')));
  assert.equal(fs.readFileSync(path.join(root, 'util.js'), 'utf8'), 'export const x = 1;\n');
  assert.ok(!fs.existsSync(path.join(root, 'notes.txt')));
  assert.equal(requests[0].tools, undefined);
  assert.match(requests[0].messages[0].content, /reply with ONLY one JSON object/);
  const results = requests[3].messages.filter((m) => m.role === 'user' && m.content.startsWith('Result of'));
  assert.match(results[0].content, /outside the project/);
  assert.match(results[2].content, /rejected[\s\S]*not needed/);
  server.close();
});

test('learning: stated preferences are saved and the session is distilled', async () => {
  const root = project();
  const { server, url } = await mockOllama({
    tools: true,
    script: [
      { content: 'Sure.' },
      { content: '{"notes":[{"text":"Prefers short summaries","scope":"global"},{"text":"Uses Express in this repo","scope":"project"}]}' }
    ]
  });
  const cfg = { ...DEFAULTS, host: url, model: 'mock' };
  const { ui } = quietUI();
  ui.yes = true;
  const memory = new Memory(root, cfg);
  const agent = new Agent({ cfg, root, ui, client: new OllamaClient(url), memory });
  await agent.init();
  await agent.run('Explain the code. I prefer single quotes.');
  assert.ok(memory.profile.notes.some((n) => n.text === 'I prefer single quotes' && n.key === 'style.quotes'));
  const learned = await agent.learn();
  assert.deepEqual(learned, ['Prefers short summaries', 'Uses Express in this repo']);
  const fresh = new Memory(root, cfg);
  assert.ok(fresh.project.some((n) => n.text === 'Uses Express in this repo'));
  assert.match(fresh.forPrompt('anything'), /single quotes[\s\S]*Express/);
  server.close();
});

test('adaptive approvals: suggests allowlisting a command after repeated approvals', async () => {
  const root = project();
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"echo ok"}}');
  const { server, url } = await mockOllama({
    tools: true,
    script: [
      { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'npm test' } } }] },
      { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'npm test -- one' } } }] },
      { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'npm test -- two' } } }] },
      { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'npm test -- three' } } }] },
      { content: 'Tests pass.' }
    ]
  });
  const cfg = { ...DEFAULTS, host: url, model: 'mock', allowlist: [...DEFAULTS.allowlist] };
  // approve 3 times, accept the allowlist suggestion; the 4th run needs no prompt
  const { ui, text } = quietUI(['y', 'y', 'y', 'y']);
  const agent = new Agent({ cfg, root, ui, client: new OllamaClient(url), memory: new Memory(root, cfg) });
  agent.ctx.quietCommands = true;
  await agent.init();
  await agent.run('run the tests a few times');
  assert.ok(cfg.allowlist.includes('npm test'));
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.EMBER_HOME, 'config.json'), 'utf8'));
  assert.ok(saved.allowlist.includes('npm test'));
  assert.match(text(), /You keep approving/);
  assert.match(text(), /npm test -- three.*\(allowlisted\)/);
  server.close();
});

test('destructive commands are refused under --yes without a human', async () => {
  const root = project();
  const { server, requests, url } = await mockOllama({
    tools: true,
    script: [
      { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'rm -rf ~' } } }] },
      { content: 'I will not do that.' }
    ]
  });
  const cfg = { ...DEFAULTS, host: url, model: 'mock' };
  const { ui, text } = quietUI();
  ui.yes = true;
  const agent = new Agent({ cfg, root, ui, client: new OllamaClient(url), memory: new Memory(root, cfg) });
  await agent.init();
  await agent.run('clean up');
  const tool = requests[1].messages.find((m) => m.role === 'tool');
  assert.match(tool.content, /blocked this destructive command/);
  assert.match(text(), /Refusing dangerous action/);
  server.close();
});
