/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { quietUI, tmpdir } from './helpers.js';

const { Mutex, FileLocks, planWaves, formatTeam, sessionDiff } = await import('../src/team.js');
const { parseTasks } = await import('../src/router.js');
const { Agent } = await import('../src/agent.js');
const { OllamaClient } = await import('../src/ollama.js');
const { Memory } = await import('../src/memory.js');
const { DEFAULTS } = await import('../src/config.js');
const { writeFile } = await import('../src/tools.js');

test('parseTasks reads tasks with files, plain strings and lists', () => {
  assert.deepEqual(parseTasks('{"steps":[{"task":"Write a.js","files":["./a.js"]},"Test it"]}'), [{ task: 'Write a.js', files: ['a.js'] }, { task: 'Test it', files: [] }]);
  assert.deepEqual(parseTasks('1. one thing\n2. other thing').map((t) => t.task), ['one thing', 'other thing']);
});

test('planWaves runs disjoint files together and unknown-file tasks alone', () => {
  const t = (task, files) => ({ task, files });
  const w = planWaves([t('a', ['a.js']), t('b', ['b.js']), t('c', ['c.js']), t('a2', ['a.js']), t('x', []), t('d', ['d.js'])], 2);
  assert.deepEqual(w.map((x) => x.map((y) => y.task)), [['a', 'b'], ['c', 'a2'], ['x'], ['d']]);
  // same file never shares a wave
  for (const wave of w) { const fs2 = wave.flatMap((x) => x.files); assert.equal(new Set(fs2).size, fs2.length); }
  assert.deepEqual(planWaves([t('a', ['a.js']), t('b', ['a.js'])]).map((x) => x.length), [1, 1]);
});

test('Mutex runs jobs one at a time in order; FileLocks keep files to one owner', async () => {
  const m = new Mutex();
  let active = 0, max = 0;
  const order = [];
  await Promise.all([1, 2, 3].map((i) => m.run(async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 15)); order.push(i); active--; })));
  assert.equal(max, 1);
  assert.deepEqual(order, [1, 2, 3]);
  const l = new FileLocks();
  assert.ok(l.acquire('/x', 'coder-1'));
  assert.ok(!l.acquire('/x', 'coder-2'));
  assert.equal(l.holder('/x'), 'coder-1');
  l.releaseAll('coder-1');
  assert.ok(l.acquire('/x', 'coder-2'));
});

test('a locked file is refused to other helpers, with a clear message', async () => {
  const root = tmpdir();
  const { ui } = quietUI([], { yes: true });
  const locks = new FileLocks();
  const base = { root, ui, cfg: structuredClone(DEFAULTS), backups: [], plan: [], always: { writes: false, commands: new Set(), tools: new Set() }, session: { events: [], writes: new Map(), said: [] }, locks, uiLock: new Mutex() };
  const one = { ...base, owner: 'coder-1' }, two = { ...base, owner: 'coder-2' };
  assert.match(await writeFile(one, { path: 'a.js', content: '1' }), /Created/);
  assert.match(await writeFile(two, { path: 'a.js', content: '2' }), /being changed by the coder-1 helper/);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), '1');
  assert.match(await writeFile(one, { path: 'a.js', content: '3' }), /Updated/);
});

/** A mock Ollama that answers slowly so we can see helpers overlap. */
function slowOllama({ plan, coder, review = 'LGTM', delay = 120 }) {
  let active = 0;
  const stats = { maxActive: 0, chats: [], reviews: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const j = body ? JSON.parse(body) : {};
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock:latest', model: 'mock:latest' }] }));
      if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
      if (req.url !== '/api/chat') { res.statusCode = 404; return res.end('{}'); }
      const sys = j.messages[0]?.content || '';
      let msg;
      if (/^Split the developer/.test(sys)) msg = { content: plan };
      else if (/code reviewer/.test(sys)) { stats.reviews.push(j); msg = { content: review }; }
      else {
        stats.chats.push(j);
        active++; stats.maxActive = Math.max(stats.maxActive, active);
        await new Promise((r) => setTimeout(r, delay));
        active--;
        msg = coder(j);
      }
      res.end(JSON.stringify({ message: { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls }, done: true }) + '\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, stats, url: `http://127.0.0.1:${server.address().port}` })));
}

const lastUser = (j) => [...j.messages].reverse().find((m) => m.role === 'user')?.content || '';
const firstUser = (j) => j.messages.find((m) => m.role === 'user')?.content || '';
const write = (p, content) => ({ tool_calls: [{ function: { name: 'write_file', arguments: { path: p, content } } }] });

function makeAgent(root, url, ui, extra = {}) {
  const cfg = { ...structuredClone(DEFAULTS), host: url, model: 'mock', fastModel: null, git: { checkpoints: false }, index: { enabled: false }, ...extra };
  return new Agent({ cfg, root, ui, client: new OllamaClient(url), memory: new Memory(root, { ...cfg, memory: { enabled: false } }) });
}

const BIG = 'Build a small math library: create add.js with an add function, create sub.js with a sub function, and add tests for both, then run the tests';

test('team: coders on different files run at the same time, approvals stay one at a time, tester and reviewer finish', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 't', type: 'module', scripts: { test: 'node -e "process.exit(0)"' } }));
  const plan = JSON.stringify({ steps: [{ task: 'Create add.js', files: ['add.js'] }, { task: 'Create sub.js', files: ['sub.js'] }] });
  const coder = (j) => {
    const task = firstUser(j);
    const done = /^(Created|Updated)/m.test(lastUser(j)) || j.messages.some((m) => m.role === 'tool');
    if (done) return { content: 'Done.' };
    return /coder-1/.test(task) && /add\.js/.test(task) ? write('add.js', 'export const add = (a, b) => a + b;\n')
      : /sub\.js/.test(task) ? write('sub.js', 'export const sub = (a, b) => a - b;\n') : write('add.js', 'export const add = (a, b) => a + b;\n');
  };
  const { server, stats, url } = await slowOllama({ plan, coder, review: '- sub.js: no input validation' });
  try {
    const { ui, text } = quietUI(['y', 'y'], { yes: false });
    let inConfirm = 0, maxConfirm = 0;
    const orig = ui.confirm.bind(ui);
    ui.confirm = async (...a) => { inConfirm++; maxConfirm = Math.max(maxConfirm, inConfirm); await new Promise((r) => setTimeout(r, 20)); try { return await orig(...a); } finally { inConfirm--; } };
    const agent = makeAgent(root, url, ui, { selfFix: { enabled: true, maxAttempts: 1, timeoutSec: 30 }, allowlist: [...DEFAULTS.allowlist, 'npm test'] });
    await agent.init();
    await agent.runTask(BIG);
    assert.equal(fs.readFileSync(path.join(root, 'add.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
    assert.equal(fs.readFileSync(path.join(root, 'sub.js'), 'utf8'), 'export const sub = (a, b) => a - b;\n');
    assert.equal(stats.maxActive, 2, 'two coder helpers talked to the model at the same time');
    assert.equal(maxConfirm, 1, 'approval prompts never overlap');
    const roles = agent.team.helpers.map((h) => `${h.role}:${h.state}`);
    assert.deepEqual(roles, ['planner:done', 'coder-1:done', 'coder-2:done', 'tester:done', 'reviewer:done']);
    assert.equal(stats.reviews.length, 1);
    assert.match(stats.reviews[0].messages[1].content, /\+export const sub/);
    const out = text();
    assert.match(out, /\[coder-1\]/);
    assert.match(out, /\[coder-2\]/);
    assert.match(out, /Reviewer notes[\s\S]*no input validation/);
    assert.match(formatTeam(agent.team), /coder-2[\s\S]*sub\.js[\s\S]*reviewer/);
    assert.equal(agent.ctx.locks, null, 'locks released after the run');
    assert.equal(agent.ctx.backups.length, 2, 'undo history shared with the main session');
  } finally { server.close(); }
});

test('team: off, or tasks on the same file, falls back to sequential steps', async () => {
  for (const [label, extra, plan] of [
    ['off', { team: { enabled: false } }, JSON.stringify({ steps: [{ task: 'Create add.js', files: ['add.js'] }, { task: 'Create sub.js', files: ['sub.js'] }] })],
    ['same file', {}, JSON.stringify({ steps: [{ task: 'Create add.js', files: ['add.js'] }, { task: 'Extend add.js', files: ['add.js'] }] })]
  ]) {
    const root = tmpdir();
    const coder = (j) => (j.messages.some((m) => m.role === 'tool') ? { content: 'ok' } : write(/Extend|sub/.test(lastUser(j)) && /sub\.js/.test(lastUser(j)) ? 'sub.js' : 'add.js', 'x\n'));
    const { server, stats, url } = await slowOllama({ plan, coder, delay: 30 });
    try {
      const { ui } = quietUI([], { yes: true });
      const agent = makeAgent(root, url, ui, { selfFix: { enabled: false }, ...extra });
      await agent.init();
      await agent.runTask(BIG);
      assert.equal(stats.maxActive, 1, label);
      assert.equal(agent.team, undefined, label);
      if (label === 'off') assert.deepEqual(agent.ctx.plan.map((p) => p.status), ['done', 'done'], label);
    } finally { server.close(); }
  }
});

test('sessionDiff builds a diff from Ember backups', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.js'), 'new\n');
  const d = sessionDiff({ root, backups: [{ abs: path.join(root, 'a.js'), before: 'old\n' }] });
  assert.match(d, /-old\n\+new/);
});

test('parseTasks recovers from fenced, truncated JSON and merges same-file neighbours', () => {
  const truncated = '```json\n{"steps":[{"task":"Create add.js","files":["add.js"]},{"task":"Export add","files":["add.js"]},{"task":"Create sub.js","files":["sub.js"]},{"task":"Create mu';
  assert.deepEqual(parseTasks(truncated), [{ task: 'Create add.js; Export add', files: ['add.js'] }, { task: 'Create sub.js', files: ['sub.js'] }]);
  assert.deepEqual(parseTasks('"task": "x",\n"files": ["a"]\n1. real step here'), [{ task: 'real step here', files: [] }]);
});
