/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// `ember watch`: re-run the project's checks when files change and offer a fix when they break.
import fs from 'node:fs';
import path from 'node:path';
import { detectChecks, failed } from './checks.js';
import { execShell } from './tools.js';
import { c } from './ui.js';

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.ember', '__pycache__', '.venv', 'target']);

/** Map of file -> mtimeMs for the project (polling works on every OS and Node 18). */
export function scanTree(root, max = 20000) {
  const out = new Map();
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.size >= max) return;
      if (IGNORE.has(e.name) || (e.name.startsWith('.') && e.name !== '.env')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { out.set(p, fs.statSync(p).mtimeMs); } catch { /* gone */ } }
    }
  };
  walk(root);
  return out;
}

export function diffTrees(a, b) {
  const changed = [];
  for (const [f, m] of b) if (a.get(f) !== m) changed.push(f);
  for (const f of a.keys()) if (!b.has(f)) changed.push(f);
  return changed;
}

export async function runWatch({ agent, ui, cfg, root }) {
  const checks = detectChecks(root, cfg);
  if (!checks.length) {
    ui.error('No test/build/lint command found. Add a "test" script to package.json, or set "checks": { "commands": ["..."] } in ~/.ember/config.json.');
    return 1;
  }
  ui.print(c.bold().yellow('Ember watch') + c.gray(` · ${root}`));
  ui.print(`  On every change Ember will run: ${checks.map((x) => c.yellow(x.command)).join(', ')}`);
  const ok = await ui.confirm('Run these automatically while watching?', { allowAlways: false, defaultNo: false });
  if (ok !== 'y') return 0;
  ui.print(c.gray('  watching… (Ctrl+C to stop)'));

  let tree = scanTree(root);
  let busy = false;
  const runChecks = async () => {
    for (const ch of checks) {
      ui.print(c.gray(`\n${new Date().toLocaleTimeString()} `) + c.yellow(`$ ${ch.command}`));
      const out = await execShell({ ...agent.ctx, quietCommands: true }, ch.command, cfg.selfFix?.timeoutSec ?? 300);
      if (failed(out)) return { ch, out };
    }
    return null;
  };
  const cycle = async (changed) => {
    busy = true;
    try {
      ui.print(c.gray(`  changed: ${changed.slice(0, 5).map((f) => path.relative(root, f)).join(', ')}${changed.length > 5 ? ' …' : ''}`));
      const fail = await runChecks();
      if (!fail) { ui.ok('All checks pass'); return; }
      ui.error(`${fail.ch.command} failed`);
      ui.print(c.gray(fail.out.split('\n').slice(-25).join('\n')));
      const fix = await ui.confirm('Ask Ember to fix it?', { allowAlways: false });
      if (fix === 'y') {
        await agent.runTask(`\`${fail.ch.command}\` is failing after recent edits. Output:\n${fail.out.slice(-6000)}\n\nFind the cause and fix it.`);
      }
    } catch (e) { ui.error(e.message); }
    finally { tree = scanTree(root); busy = false; }
  };

  let pending = null;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (busy) return;
      const next = scanTree(root);
      const changed = diffTrees(tree, next);
      tree = next;
      if (!changed.length) return;
      clearTimeout(pending);
      pending = setTimeout(() => cycle(changed), cfg.watch?.debounceMs ?? 600);
    }, cfg.watch?.intervalMs ?? 1000);
    ui.onInterrupt = () => { clearInterval(timer); ui.print(c.gray('\nstopped watching')); resolve(0); };
    process.on('SIGINT', () => ui.onInterrupt());
  });
}
