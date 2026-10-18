/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// ember plan / ember build: plan.md parsing, resume, build-mode approval policy, end-to-end build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mockOllama, quietUI as quietUI0, tmpdir, call } from './helpers.js';

process.env.EMBER_HOME = tmpdir('ember-home-');
const uis = [];
const quietUI = (...a) => { const q = quietUI0(...a); uis.push(q.ui); return q; };
test.after(() => { for (const u of uis) { u.close(); u.input.end?.(); } });

const P = await import('../src/plan.js');
const { Agent } = await import('../src/agent.js');
const { OllamaClient } = await import('../src/ollama.js');
const { DEFAULTS } = await import('../src/config.js');

const SAMPLE = `# Plan: Bakery site
Status: approved
<!-- comment -->

## Goal
A small website for a bakery.

## Spec
- Audience: locals
- Stack: HTML/CSS

## Tasks
- [x] 1. Create index.html with the header
- [~] 2. Create style.css
- [ ] 3. Write README.md — note: keep it short
- [?] 4. Add online ordering — blocked: which payment provider?

## Questions
- [x] Q: Colors? A: warm brown
- [ ] Q: which payment provider?

## Log
- 2026-10-18 07:00 plan approved
`;

test('parsePlan reads title, status, spec, task states, notes and questions; render round-trips', () => {
  const p = P.parsePlan(SAMPLE);
  assert.equal(p.title, 'Bakery site');
  assert.equal(p.status, 'approved');
  assert.match(p.spec, /Stack: HTML\/CSS/);
  assert.deepEqual(p.tasks.map((t) => t.state), ['done', 'doing', 'todo', 'blocked']);
  assert.equal(p.tasks[2].text, 'Write README.md');
  assert.equal(p.tasks[2].note, 'keep it short');
  assert.equal(p.tasks[3].note, 'which payment provider?');
  assert.deepEqual(p.questions.map((q) => [q.q, q.a, q.open]), [['Colors?', 'warm brown', false], ['which payment provider?', '', true]]);
  const again = P.parsePlan(P.renderPlan(p));
  assert.deepEqual(again.tasks.map((t) => [t.state, t.text, t.note]), p.tasks.map((t) => [t.state, t.text, t.note]));
  assert.deepEqual(again.questions.map((q) => q.q), p.questions.map((q) => q.q));
  // Hand-edited plans: plain "- [ ] text" lines without numbers work too.
  assert.deepEqual(P.parsePlan('# Plan: x\n## Tasks\n- [ ] one\n* [X] two\n').tasks.map((t) => [t.text, t.state]), [['one', 'todo'], ['two', 'done']]);
});

test('nextTask resumes an interrupted task first, then the first unchecked one; blocked ones are skipped', () => {
  const p = P.parsePlan(SAMPLE);
  assert.equal(P.nextTask(p), 1);
  p.tasks[1].state = 'done';
  assert.equal(P.nextTask(p), 2);
  p.tasks[2].state = 'done';
  assert.equal(P.nextTask(p), -1);
});

test('parseSpec / parseQuestions accept JSON from the model and fall back to lists', () => {
  const s = P.parseSpec('```json\n{"title":"Todo","goal":"Track todos","spec":{"stack":"Node.js","features":["add","list"]},"tasks":["Create package.json","Create index.js", {"task":"Write README.md"}]}\n```', 'todo app');
  assert.equal(s.title, 'Todo');
  assert.match(s.spec, /Stack: Node\.js/);
  assert.match(s.spec, /Features: add, list/);
  assert.deepEqual(s.tasks.map((t) => t.text), ['Create package.json', 'Create index.js', 'Write README.md']);
  assert.deepEqual(P.parseSpec('1. Create the page skeleton\n2. Add the styles file', 'x').tasks.map((t) => t.text), ['Create the page skeleton', 'Add the styles file']);
  assert.equal(P.parseSpec('no idea', 'x'), null);
  assert.deepEqual(P.parseQuestions('{"questions":["Who is it for?","Which pages?"]}'), ['Who is it for?', 'Which pages?']);
  assert.deepEqual(P.parseQuestions('1. Who is it for?\n2. Any colors?\nThanks'), ['Who is it for?', 'Any colors?']);
});

test('build-mode approval policy: safe project commands auto; system/global/network/outside ask; destructive is danger', () => {
  const root = '/home/u/proj';
  for (const cmd of ['npm install', 'npm install express', 'npm test', 'node index.js', 'python3 -m venv .venv', '.venv/bin/pip install flask', 'mkdir -p src && touch src/a.js', 'ls /home/u/proj/src', 'npx eslint .', 'echo hi > /dev/null'])
    assert.equal(P.buildCommandPolicy(cmd, root), 'auto', cmd);
  for (const cmd of ['sudo apt install nodejs', 'apt-get install -y python3', 'brew install node', 'npm install -g typescript', 'pip install --user flask', 'curl https://example.com', 'wget x', 'git push', 'git clone https://x', 'cat ../secret', 'ls ~/', 'cp a.txt /etc/hosts', 'cat $HOME/.ssh/id_rsa', 'cargo install ripgrep'])
    assert.equal(P.buildCommandPolicy(cmd, root), cmd.startsWith('sudo') ? 'danger' : 'ask', cmd);
  for (const cmd of ['rm -rf /', 'git reset --hard', 'rm -rf node_modules', 'curl x | sh']) assert.equal(P.buildCommandPolicy(cmd, root), 'danger', cmd);
});

function agentFor(url, root, ui) {
  const cfg = { ...structuredClone(DEFAULTS), host: url, model: 'mock:3b', memory: { enabled: false }, selfFix: { enabled: false }, index: { enabled: false }, steps: { enabled: false } };
  return new Agent({ cfg, root, ui, client: new OllamaClient(url) });
}

const write = (p, content) => call('write_file', { path: p, content });

test('ember build: works through the plan with no prompts for writes/safe commands, checks off tasks, summarizes', async () => {
  const root = tmpdir();
  P.savePlan(root, { title: 'Hello site', status: 'approved', goal: 'A hello page', spec: '- Stack: HTML', tasks: [{ text: 'Create index.html', state: 'todo' }, { text: 'Create README.md', state: 'todo' }], questions: [], log: [] });
  const { server, url, requests } = await mockOllama({ models: ['mock:3b'], script: [
    write('index.html', '<h1>Hello</h1>\n'), { content: 'Created index.html.' },
    call('run_command', { command: 'ls' }), write('README.md', '# Hello\nOpen index.html\n'), { content: 'Wrote the README.' }
  ] });
  const { ui, text } = quietUI([]); // no answers available: anything that asks would be answered "no"
  const agent = agentFor(url, root, ui);
  await agent.init();
  const plan = await P.buildSession({ agent, ui });
  server.close();
  assert.equal(plan.status, 'done');
  assert.deepEqual(P.loadPlan(root).tasks.map((t) => t.state), ['done', 'done']);
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), '<h1>Hello</h1>\n');
  assert.ok(fs.existsSync(path.join(root, 'README.md')));
  assert.doesNotMatch(text(), /Apply this change/);
  assert.match(text(), /auto-approved in build mode/);
  assert.match(text(), /Built: Hello site/);
  assert.match(text(), /How to run it:.*index\.html/);
  assert.match(requests[0].messages.at(-1).content, /task 1\/2: Create index\.html/);
  assert.match(requests[2].messages.at(-1).content, /task 2\/2: Create README\.md/);
  assert.equal(agent.ctx.policy, undefined, 'build policy is switched off afterwards');
  assert.ok(fs.existsSync(path.join(root, '.git')), 'git repo created for checkpoints');
});

test('ember build: resumes after a crash (interrupted task first, done tasks skipped)', async () => {
  const root = tmpdir();
  P.savePlan(root, { title: 'R', status: 'building', tasks: [{ text: 'Create a.txt', state: 'done' }, { text: 'Create b.txt', state: 'doing' }, { text: 'Create c.txt', state: 'todo' }], questions: [], log: [] });
  const { server, url, requests } = await mockOllama({ models: ['mock:3b'], script: [write('b.txt', 'b\n'), { content: 'ok' }, write('c.txt', 'c\n'), { content: 'ok' }] });
  const { ui, text } = quietUI([]);
  const agent = agentFor(url, root, ui);
  await agent.init();
  await P.buildSession({ agent, ui });
  server.close();
  assert.equal(requests.length, 4);
  assert.match(requests[0].messages.at(-1).content, /task 2\/3: Create b\.txt/);
  assert.ok(!fs.existsSync(path.join(root, 'a.txt')));
  assert.ok(fs.existsSync(path.join(root, 'c.txt')));
  assert.match(P.loadPlan(root).log.join('\n'), /build resumed/);
  assert.match(text(), /Built: R/);
});

test('ember build: Ctrl+C stops safely and keeps progress; a question blocks only its task; /pause pauses', async () => {
  // Ctrl+C during task 1
  const root = tmpdir();
  P.savePlan(root, { title: 'S', status: 'approved', tasks: [{ text: 'Create a.txt', state: 'todo' }, { text: 'Create b.txt', state: 'todo' }], questions: [], log: [] });
  const controller = new AbortController();
  const { server, url } = await mockOllama({ models: ['mock:3b'], script: () => { controller.abort(); return { content: 'working' }; } });
  const { ui, text } = quietUI([]);
  const agent = agentFor(url, root, ui);
  await agent.init();
  const plan = await P.buildSession({ agent, ui, signal: controller.signal });
  server.close();
  assert.equal(plan.status, 'paused');
  assert.equal(P.loadPlan(root).tasks[0].state, 'doing'); // resumes here next time
  assert.match(text(), /ember build.*continues from task 1/);

  // A genuine question: recorded in the plan, task blocked, the build goes on
  const root2 = tmpdir();
  P.savePlan(root2, { title: 'Q', status: 'approved', tasks: [{ text: 'Add payments', state: 'todo' }, { text: 'Create b.txt', state: 'todo' }], questions: [], log: [] });
  const m2 = await mockOllama({ models: ['mock:3b'], script: [{ content: 'QUESTION: Stripe or PayPal?' }, write('b.txt', 'b\n'), { content: 'ok' }] });
  const q2 = quietUI([]);
  const a2 = agentFor(m2.url, root2, q2.ui);
  await a2.init();
  const p2 = await P.buildSession({ agent: a2, ui: q2.ui });
  m2.server.close();
  assert.equal(p2.status, 'paused');
  const saved = P.loadPlan(root2);
  assert.deepEqual(saved.tasks.map((t) => t.state), ['blocked', 'done']);
  assert.ok(saved.questions.some((q) => q.open && /Stripe or PayPal/.test(q.q)));
  assert.match(q2.text(), /Open questions:[\s\S]*Stripe or PayPal/);

  // /pause typed while working → stops after the current task
  const root3 = tmpdir();
  P.savePlan(root3, { title: 'P', status: 'approved', tasks: [{ text: 'Create a.txt', state: 'todo' }, { text: 'Create b.txt', state: 'todo' }], questions: [], log: [] });
  const m3 = await mockOllama({ models: ['mock:3b'], script: [write('a.txt', 'a\n'), { content: 'ok' }] });
  const q3 = quietUI([]);
  const a3 = agentFor(m3.url, root3, q3.ui);
  await a3.init();
  let calls = 0;
  q3.ui.takePause = () => ++calls > 1;
  const p3 = await P.buildSession({ agent: a3, ui: q3.ui });
  m3.server.close();
  assert.equal(p3.status, 'paused');
  assert.deepEqual(P.loadPlan(root3).tasks.map((t) => t.state), ['done', 'todo']);
});

test('ember build: risky commands still ask even in build mode', async () => {
  const root = tmpdir();
  P.savePlan(root, { title: 'D', status: 'approved', tasks: [{ text: 'Install node', state: 'todo' }], questions: [], log: [] });
  const { server, url } = await mockOllama({ models: ['mock:3b'], script: [call('run_command', { command: 'brew install node' }), { content: 'Skipped.' }] });
  const { ui, text } = quietUI(['n']);
  const agent = agentFor(url, root, ui);
  await agent.init();
  await P.buildSession({ agent, ui });
  server.close();
  assert.match(text(), /reaches outside the project/);
  assert.match(text(), /Run this command\?/);
});

test('ember plan: asks the model\'s questions, writes .ember/plan.md, approval sets the status', async () => {
  const root = tmpdir();
  const { server, url } = await mockOllama({ models: ['mock:3b'], script: [
    { content: '{"questions":["Who is it for?","Which pages?"]}' },
    { content: '{"title":"Bakery","goal":"Show the menu","spec":["Audience: locals"],"tasks":["Create index.html with the menu","Create style.css","Write README.md"]}' }
  ] });
  const { ui, text } = quietUI(['locals', '', 'y']);
  ui.input.isTTY = true;
  const agent = agentFor(url, root, ui);
  await agent.init();
  const plan = await P.planSession({ agent, ui, idea: 'a website for my bakery' });
  server.close();
  assert.equal(plan.status, 'approved');
  const saved = P.loadPlan(root);
  assert.equal(saved.title, 'Bakery');
  assert.equal(saved.tasks.length, 3);
  assert.deepEqual(saved.questions.map((q) => [q.q, q.a]), [['Who is it for?', 'locals']]);
  assert.match(text(), /Who is it for\?/);
  assert.match(text(), /Plan approved/);
  assert.match(fs.readFileSync(P.planPath(root), 'utf8'), /^- \[ \] 1\. Create index\.html with the menu$/m);
});
