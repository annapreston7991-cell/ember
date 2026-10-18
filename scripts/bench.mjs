/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Speed benchmark against a real local Ollama. Usage:
//   node scripts/bench.mjs [model] [--fast <model>]
// Runs three fixed jobs in temp folders and prints wall time, model calls and tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable, PassThrough } from 'node:stream';

process.env.EMBER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-bench-home-'));
const { Agent } = await import('../src/agent.js');
const { Memory } = await import('../src/memory.js');
const { UI } = await import('../src/ui.js');
const { loadConfig } = await import('../src/config.js');

const args = process.argv.slice(2);
const model = args.find((a) => !a.startsWith('--')) || 'qwen2.5-coder:7b';
const fastIdx = args.indexOf('--fast');
const fast = fastIdx >= 0 ? args[fastIdx + 1] : undefined;

function quietUI() {
  const output = new Writable({ write(_c, _e, cb) { cb(); } });
  return new UI({ yes: true, input: new PassThrough(), output });
}

async function job(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-bench-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bench', type: 'module', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'greet.js'), 'export function greet(name) {\n  return "Hello " + name;\n}\n');
  const cfg = { ...loadConfig(), model };
  if (fast) cfg.fastModel = fast;
  cfg.memory = { ...cfg.memory, enabled: false };
  cfg.git = { checkpoints: false };
  const ui = quietUI();
  const agent = new Agent({ cfg, root, ui, memory: new Memory(root, cfg) });
  agent.ctx.quietCommands = true;
  const logs = [];
  for (const c of agent.clients?.() || [agent.client]) c.log = logs;
  await agent.init();
  const t0 = Date.now();
  let ok = true;
  const row0 = {};
  try { await fn(agent, root); } catch (e) { ok = false; row0.error = e.message; }
  const ms = Date.now() - t0;
  const sum = (k) => logs.reduce((n, l) => n + (l[k] || 0), 0);
  const row = { job: name, ok, seconds: +(ms / 1000).toFixed(1), calls: logs.length, promptTokens: sum('promptTokens'), outputTokens: sum('outputTokens'), loadS: +(sum('loadMs') / 1000).toFixed(1), promptEvalS: +(sum('promptMs') / 1000).toFixed(1), genS: +(sum('evalMs') / 1000).toFixed(1), models: [...new Set(logs.map((l) => l.model))].join(','), ...row0 };
  return row;
}

const rows = [];
rows.push(await job('code: add.js + test + npm test', async (a, root) => {
  await a.runTask('Create add.js exporting function add(a, b) returning a + b (ES modules), create add.test.js using node:test and node:assert checking add(2, 3) === 5, then run npm test.');
  if (!fs.existsSync(path.join(root, 'add.js'))) throw new Error('add.js missing');
}));
rows.push(await job('commit message', async (a) => { await a.commitMessage('diff --git a/greet.js b/greet.js\n+export function bye(name) {\n+  return "Bye " + name;\n+}\n'); }));
rows.push(await job('explain greet.js', async (a, root) => {
  const { explainPrompt } = await import('../src/repl.js');
  await a.explain(explainPrompt('greet.js', root));
}));
rows.push(await job('follow-up turn (cache reuse)', async (a) => {
  await a.run('In one sentence, what does greet.js export?');
  await a.run('And what would greet("Ann") return? One line.');
}));
console.log(JSON.stringify({ model, fast: fast || null, rows }, null, 2));
