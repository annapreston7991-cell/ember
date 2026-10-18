/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mockOllama, quietUI, tmpdir, call } from './helpers.js';

process.env.EMBER_HOME = tmpdir('ember-home-');
const { Agent } = await import('../src/agent.js');
const { Memory } = await import('../src/memory.js');
const { DEFAULTS } = await import('../src/config.js');
const { classifyTask, parseSteps } = await import('../src/router.js');
const { pickModel, pickFastModel, pickNumCtx, parseNvidia, amdFromSysfs } = await import('../src/hardware.js');

const cfgFor = (url, extra = {}) => ({ ...structuredClone(DEFAULTS), host: url, model: 'mock', ...extra });
const mk = (root, cfg, ui) => new Agent({ cfg, root, ui, memory: new Memory(root, cfg) });

test('task classification is local and cheap', () => {
  assert.equal(classifyTask('What does server.js do?'), 'question');
  assert.equal(classifyTask('fix the typo in README'), 'small');
  assert.equal(classifyTask('Create add.js, add a test for it, then run npm test'), 'small');
  assert.equal(classifyTask('Create add.js exporting add() and create add.test.js, then run npm test'), 'small');
  assert.equal(classifyTask('Create a.js, add b.js, write c.js, then run the tests'), 'big');
  assert.equal(classifyTask('Build a todo app with Express and SQLite'), 'big');
  assert.equal(classifyTask('1. add login\n2. add logout\n3. add tests'), 'big');
});

test('planner output parsing', () => {
  assert.deepEqual(parseSteps('Sure! {"steps":["Write a.js","Test a.js"]}'), ['Write a.js', 'Test a.js']);
  assert.deepEqual(parseSteps('1. Write a.js\n2. Test a.js'), ['Write a.js', 'Test a.js']);
  assert.deepEqual(parseSteps('{"steps":[{"step":"x1 y"}]}'), ['x1 y']);
  assert.equal(parseSteps('{"steps":["a","b","c","d","e","f","g","h"]}', 6).length, 6);
});

test('requests ask Ollama to keep the model loaded, and the system prompt stays cache-stable', async () => {
  const root = tmpdir();
  const { server, requests, url } = await mockOllama({ script: [{ content: 'one' }, { content: 'two' }] });
  const { ui } = quietUI([], { yes: true });
  const agent = mk(root, cfgFor(url, { keepAlive: '45m' }), ui);
  await agent.init();
  await agent.run('hi');
  await agent.run('what about this other topic entirely?');
  assert.equal(requests[0].keep_alive, '45m');
  assert.equal(requests[0].messages[0].content, requests[1].messages[0].content);
  // history is a pure prefix extension (no rewrites) so the KV cache is reused
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
  server.close();
});

test('router sends quick jobs to the fast model and coding to the main model', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.js'), 'x');
  const { server, requests, url } = await mockOllama({ models: ['mock:latest', 'tiny:latest'], script: [{ content: 'Add bye()' }, { content: 'It is x.' }, { content: 'coded' }] });
  const { ui } = quietUI([], { yes: true });
  const agent = mk(root, cfgFor(url, { fastModel: 'tiny' }), ui);
  await agent.init();
  assert.ok(agent.fast);
  await agent.commitMessage('diff');
  await agent.explain('what is a.js?');
  await agent.run('change a.js');
  assert.deepEqual(requests.map((r) => r.model), ['tiny', 'tiny', 'mock']);
  assert.equal(agent.model, 'mock');
  // fast model missing → falls back to main
  const a2 = mk(root, cfgFor(url, { fastModel: 'not-installed' }), ui);
  await a2.init();
  assert.equal(a2.fast, null);
  server.close();
});

test('big jobs run as small focused steps with short contexts', async () => {
  const root = tmpdir();
  const { server, requests, planRequests, url } = await mockOllama({
    plan: '{"steps":["Write a.js","Write b.js"]}',
    script: [call('write_file', { path: 'a.js', content: 'a' }), { content: 'a done' }, call('write_file', { path: 'b.js', content: 'b' }), { content: 'b done' }]
  });
  const { ui } = quietUI([], { yes: true });
  const agent = mk(root, cfgFor(url, { selfFix: { enabled: false } }), ui);
  await agent.init();
  await agent.runTask('Create a.js, create b.js, add tests for both files, then run them');
  assert.equal(planRequests.length, 1);
  assert.ok(fs.existsSync(path.join(root, 'a.js')) && fs.existsSync(path.join(root, 'b.js')));
  const step2 = requests[2].messages.filter((m) => m.role === 'user');
  assert.equal(step2.length, 1, 'step 2 starts with a fresh, short context');
  assert.match(step2[0].content, /Already done:\n- Write a\.js[\s\S]*step \(2\/2\): Write b\.js/);
  assert.deepEqual(agent.ctx.plan.map((p) => p.status), ['done', 'done']);
  assert.equal(agent.messages.length, 2);
  server.close();
});

test('hardware: GPU parsing and model picks', () => {
  assert.deepEqual(parseNvidia('NVIDIA GeForce RTX 4070, 12282\n'), [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', vramGB: 12 }]);
  const sys = tmpdir('ember-sysfs-');
  fs.mkdirSync(path.join(sys, 'card0', 'device'), { recursive: true });
  fs.writeFileSync(path.join(sys, 'card0', 'device', 'vendor'), '0x1002\n');
  fs.writeFileSync(path.join(sys, 'card0', 'device', 'mem_info_vram_total'), String(16 * 1024 ** 3));
  fs.mkdirSync(path.join(sys, 'card1', 'device'), { recursive: true });
  fs.writeFileSync(path.join(sys, 'card1', 'device', 'vendor'), '0x8086\n');
  assert.deepEqual(amdFromSysfs(sys).map((g) => g.vramGB), [16]);
  assert.equal(pickModel({ ramGB: 32, vramGB: 12 }), 'qwen2.5-coder:14b');
  assert.equal(pickModel({ ramGB: 16, vramGB: 0 }), 'qwen2.5-coder:7b');
  assert.equal(pickModel({ ramGB: 64, appleSilicon: true }), 'qwen2.5-coder:32b');
  assert.equal(pickFastModel('qwen2.5-coder:7b'), 'qwen2.5-coder:1.5b');
  assert.equal(pickFastModel('qwen2.5-coder:32b', { vramGB: 24 }), 'qwen2.5-coder:3b');
  assert.equal(pickFastModel('qwen2.5-coder:3b'), null);
  assert.equal(pickNumCtx({ vramGB: 24 }), 16384);
  assert.equal(pickNumCtx({ vramGB: 0, ramGB: 16 }), 8192);
});
