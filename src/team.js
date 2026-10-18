/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { c } from './ui.js';

/** A FIFO mutex: one approval prompt / command at a time across parallel helpers. */
export class Mutex {
  constructor() { this.tail = Promise.resolve(); this.busy = false; }
  run(fn) {
    const next = this.tail.then(async () => { this.busy = true; try { return await fn(); } finally { this.busy = false; } });
    this.tail = next.catch(() => {});
    return next;
  }
}

/** File locks: a file belongs to the helper that first changes it until that helper finishes. */
export class FileLocks {
  constructor() { this.map = new Map(); }
  holder(abs) { return this.map.get(abs) || null; }
  acquire(abs, owner) { if (!owner) return true; const h = this.map.get(abs); if (h && h !== owner) return false; this.map.set(abs, owner); return true; }
  releaseAll(owner) { for (const [k, v] of this.map) if (v === owner) this.map.delete(k); }
  held(owner) { return [...this.map].filter(([, v]) => !owner || v === owner).map(([k]) => k); }
}

/**
 * A UI view for one helper: prefixes its output with its role, buffers streamed text into lines,
 * and shares the parent's prompts (so approvals and --yes behave exactly as usual).
 */
export function helperUI(ui, role, color = c.magenta) {
  const tag = color(`[${role}]`) + ' ';
  let buf = '';
  const v = Object.create(ui);
  v.print = (s = '') => ui.print(String(s).split('\n').map((l) => (l ? tag + l : l)).join('\n'));
  v.ok = (s) => v.print(c.green('✓ ') + s);
  v.warn = (s) => v.print(c.yellow('! ') + s);
  v.info = (s) => v.print(c.cyan('› ') + s);
  v.error = (s) => v.print(c.red('✗ ') + s);
  v.write = (s) => { buf += s; const i = buf.lastIndexOf('\n'); if (i >= 0) { v.print(buf.slice(0, i)); buf = buf.slice(i + 1); } };
  v.flush = () => { if (buf.trim()) v.print(buf); buf = ''; };
  v.thinking = () => () => {};
  return v;
}

/**
 * Group tasks into waves that can run at the same time: tasks in a wave touch disjoint files.
 * A task that lists no files might touch anything, so it runs alone.
 */
export function planWaves(tasks, maxParallel = 2) {
  const waves = [];
  for (const t of tasks) {
    const files = new Set(t.files || []);
    const last = waves.at(-1);
    const fits = last && files.size && last.length < maxParallel && last.every((o) => o.files?.length && !o.files.some((f) => files.has(f)));
    if (fits) last.push(t); else waves.push([t]);
  }
  return waves;
}

export const REVIEW_PROMPT = `You are a careful code reviewer. Review the diff for real bugs only: wrong logic, crashes, missing imports, broken tests, security problems.
Reply "LGTM" if it looks fine, otherwise up to 5 short bullet points ("- file: problem"). No praise, no style nits.`;

/** Unified diff of everything this session changed, from Ember's own backups (works without git). */
export function sessionDiff(ctx, sinceIndex = 0, maxChars = 10000) {
  const first = new Map();
  for (const b of ctx.backups.slice(sinceIndex)) if (!first.has(b.abs)) first.set(b.abs, b.before);
  let out = '';
  for (const [abs, before] of first) {
    const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const r = path.relative(ctx.root, abs);
    out += createTwoFilesPatch(r, r, before ?? '', now, '', '', { context: 2 });
    if (out.length > maxChars) break;
  }
  return out.slice(0, maxChars);
}

/**
 * Run a planned job with parallel helpers:
 *   planner (already done by the caller) → coder helpers, in waves of disjoint files
 *   → tester (self-fix loop) and reviewer (fast model on the diff), side by side.
 * Every file change and command still goes through the normal approval flow, one prompt at a time.
 */
export async function runTeam(agent, text, tasks, { signal, selfFix = true } = {}) {
  const cfg = agent.cfg.team || {};
  const maxParallel = Math.max(1, cfg.maxParallel ?? 2);
  const waves = planWaves(tasks, maxParallel);
  const board = agent.team = { goal: text, started: Date.now(), helpers: [], waves: waves.length };
  const ctx = agent.ctx;
  ctx.locks = new FileLocks();
  ctx.uiLock = ctx.uiLock || new Mutex();
  const startBackups = ctx.backups.length;
  board.helpers.push({ role: 'planner', task: `split into ${tasks.length} tasks / ${waves.length} wave(s)`, state: 'done', model: agent.modelFor('plan').model });
  agent.ctx.plan = tasks.map((t) => ({ step: t.task, status: 'pending' }));
  agent.ui.print(c.gray(`  team: ${tasks.length} tasks in ${waves.length} wave(s), up to ${maxParallel} helpers at once`));

  const done = [];
  let n = 0;
  try {
    for (const wave of waves) {
      if (signal?.aborted) throw new Error('aborted');
      const others = (t) => wave.filter((o) => o !== t).flatMap((o) => o.files);
      await Promise.all(wave.map(async (t) => {
        const role = `coder-${++n}`;
        const idx = tasks.indexOf(t);
        const h = { role, task: t.task, files: t.files, state: 'running', model: agent.model, started: Date.now() };
        board.helpers.push(h);
        agent.ctx.plan[idx].status = 'in_progress';
        const helper = agent.spawnHelper(role);
        const prompt = `Overall goal: ${text}\n${done.length ? `Already done:\n${done.map((d) => `- ${d}`).join('\n')}\n` : ''}`
          + `You are ${role}, one of several helpers working at the same time. Do ONLY this task: ${t.task}\n`
          + (t.files.length ? `Your files: ${t.files.join(', ')}.\n` : '')
          + (others(t).length ? `Other helpers are editing ${others(t).join(', ')} right now. Do not touch those files.\n` : '')
          + 'When the task is done, reply with one short sentence.';
        try {
          const out = await helper.run(prompt, { signal });
          helper.ui.flush?.();
          h.state = 'done'; h.result = out.slice(0, 160);
          agent.ctx.plan[idx].status = 'done';
          done.push(`${t.task}${out ? ` (${out.slice(0, 100)})` : ''}`);
        } catch (e) {
          h.state = 'failed'; h.result = e.message;
          if (e.message === 'aborted') throw e;
        } finally {
          h.ms = Date.now() - h.started;
          ctx.locks.releaseAll(role);
        }
      }));
    }

    // Tester and reviewer run side by side: the reviewer only reads the diff, so it is safe.
    const changed = ctx.backups.length > startBackups;
    const jobs = [];
    if (changed && selfFix) {
      const h = { role: 'tester', task: 'run checks, fix failures', state: 'running', model: agent.model, started: Date.now() };
      board.helpers.push(h);
      jobs.push(agent.selfFix({ signal }).then((ok) => { h.state = ok ? 'done' : 'failed'; h.result = ok ? 'checks pass' : 'checks still failing'; h.ms = Date.now() - h.started; return ok; }));
    }
    let review = '';
    if (changed && cfg.review !== false) {
      const m = agent.modelFor('review');
      const h = { role: 'reviewer', task: 'review the diff', state: 'running', model: m.model, started: Date.now() };
      board.helpers.push(h);
      const diff = sessionDiff(ctx, startBackups);
      jobs.push(m.client.chat({ model: m.model, messages: [{ role: 'system', content: REVIEW_PROMPT }, { role: 'user', content: `Goal: ${text}\n\n${diff}` }], options: { temperature: 0, num_ctx: agent.cfg.numCtx, num_predict: 250 }, signal })
        .then((r) => { review = String(r.content || '').trim(); h.state = 'done'; h.result = /^LGTM/i.test(review) ? 'LGTM' : `${review.split('\n').filter((l) => l.trim()).length} note(s)`; })
        .catch((e) => { h.state = 'failed'; h.result = e.message; })
        .finally(() => { h.ms = Date.now() - h.started; }));
    }
    await Promise.all(jobs);
    if (review && !/^LGTM/i.test(review)) {
      agent.ui.print('');
      agent.ui.print(c.bold('Reviewer notes') + c.gray(' (not applied; ask Ember to fix any you agree with)'));
      agent.ui.print(review);
    }
    board.review = review;
  } finally {
    board.finished = Date.now();
    ctx.locks = null;
  }
  agent.messages = [{ role: 'user', content: text }, { role: 'assistant', content: `Done:\n${done.map((d) => `- ${d}`).join('\n')}${board.review && !/^LGTM/i.test(board.review) ? `\nReviewer notes:\n${board.review}` : ''}` }];
  return done.length ? done.at(-1) : '';
}

/** Text for /agents. */
export function formatTeam(board, { enabled = true, maxParallel = 2 } = {}) {
  const head = `Parallel helpers: ${enabled ? c.green('on') : c.gray('off')} · up to ${maxParallel} at once · /agents on|off`;
  if (!board) return `${head}\n${c.gray('No team run yet. Big multi-part requests are split into tasks, and tasks on different files run side by side.')}`;
  const icon = { running: c.yellow('◐'), done: c.green('✔'), failed: c.red('✗') };
  const lines = board.helpers.map((h) => `  ${icon[h.state] || '·'} ${c.bold(h.role.padEnd(9))} ${h.task.slice(0, 70)}${h.files?.length ? c.gray(` [${h.files.join(', ')}]`) : ''}${c.gray(` · ${h.model || ''}${h.ms ? ` · ${(h.ms / 1000).toFixed(1)}s` : ''}`)}${h.result ? c.gray(` → ${h.result.slice(0, 60)}`) : ''}`);
  const total = board.finished ? c.gray(`  total ${((board.finished - board.started) / 1000).toFixed(1)}s`) : c.yellow('  running…');
  return [head, `Last job: ${board.goal.slice(0, 80)}`, ...lines, total].join('\n');
}

