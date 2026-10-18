/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// `ember plan` and `ember build`: talk an idea through, write .ember/plan.md (a spec plus a task
// checklist the user can edit and approve), then let Ember build it task by task on her own.
// Small-model friendly: every model call is short and focused; the plan file is the memory.
import fs from 'node:fs';
import path from 'node:path';
import { findJsonObjects } from './parser.js';
import { isDestructive, isWithin } from './safety.js';
import { c } from './ui.js';
import { git, isRepo } from './git.js';
import { detectChecks } from './checks.js';
import { dlog } from './debug.js';

export const planPath = (root) => path.join(root, '.ember', 'plan.md');

// ---------- plan.md format ----------
// # Plan: <title>
// Status: draft | approved | building | paused | done
// ## Goal / ## Spec / ## Tasks (- [ ] / - [~] in progress / - [x] done / - [?] blocked) / ## Questions / ## Log

const STATE = { ' ': 'todo', '~': 'doing', x: 'done', X: 'done', '?': 'blocked', '!': 'blocked' };
const MARK = { todo: ' ', doing: '~', done: 'x', blocked: '?' };
const TASK_RE = /^(\s*[-*]\s+\[)([ ~xX?!])(\]\s+)(?:(\d+)[.)]\s+)?(.*)$/;

export function parsePlan(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const plan = { title: '', status: 'draft', goal: '', spec: '', tasks: [], questions: [], log: [] };
  let section = '';
  const buf = { goal: [], spec: [] };
  lines.forEach((line, i) => {
    let m;
    if ((m = /^#\s+(?:Plan:\s*)?(.*)$/.exec(line)) && !plan.title) { plan.title = m[1].trim(); return; }
    if ((m = /^Status:\s*(\w+)/i.exec(line))) { plan.status = m[1].toLowerCase(); return; }
    if ((m = /^##\s+(.*)$/.exec(line))) { section = m[1].trim().toLowerCase(); return; }
    if (section.startsWith('task') && (m = TASK_RE.exec(line))) {
      const text = m[5].trim();
      const note = /\s+—\s+(blocked|note):\s*(.*)$/i.exec(text);
      plan.tasks.push({ line: i, state: STATE[m[2]] || 'todo', text: note ? text.slice(0, note.index).trim() : text, note: note ? note[2] : '' });
      return;
    }
    if (section.startsWith('question') && (m = /^\s*[-*]\s+(?:\[([ xX])\]\s+)?(?:Q:\s*)?(.*?)(?:\s+A:\s*(.*))?$/.exec(line)) && m[2].trim()) {
      plan.questions.push({ line: i, q: m[2].trim(), a: (m[3] || '').trim(), open: !(m[3] || '').trim() && m[1] !== 'x' && m[1] !== 'X' });
      return;
    }
    if (section.startsWith('log') && /^\s*[-*]\s+/.test(line)) { plan.log.push(line.replace(/^\s*[-*]\s+/, '')); return; }
    if (section === 'goal') buf.goal.push(line);
    else if (section.startsWith('spec')) buf.spec.push(line);
  });
  plan.goal = buf.goal.join('\n').trim();
  plan.spec = buf.spec.join('\n').trim();
  return plan;
}

export function renderPlan({ title, status = 'draft', goal = '', spec = '', tasks = [], questions = [], log = [] }) {
  const out = [
    `# Plan: ${title || 'Untitled'}`,
    `Status: ${status}`,
    '<!-- Written by Ember. Edit anything: tasks are the "- [ ]" lines ([x] done, [~] in progress, [?] blocked). Run `ember build` to start or continue. -->',
    '', '## Goal', goal || '(describe the goal)', '', '## Spec', spec || '-', '', '## Tasks',
    ...tasks.map((t, i) => `- [${MARK[t.state] || ' '}] ${i + 1}. ${t.text}${t.note ? ` — ${t.state === 'blocked' ? 'blocked' : 'note'}: ${t.note}` : ''}`),
    '', '## Questions',
    ...(questions.length ? questions.map((q) => `- [${q.open ? ' ' : 'x'}] Q: ${q.q}${q.a ? ` A: ${q.a}` : ''}`) : ['- (none yet)']),
    '', '## Log', ...log.map((l) => `- ${l}`), ''
  ];
  return out.join('\n').replace(/\n- \(none yet\)\n/, '\n');
}

export function loadPlan(root) {
  try { return parsePlan(fs.readFileSync(planPath(root), 'utf8')); } catch { return null; }
}

export function savePlan(root, plan) {
  fs.mkdirSync(path.dirname(planPath(root)), { recursive: true });
  fs.writeFileSync(planPath(root), renderPlan(plan));
}

/** The task to work on next: an interrupted one first, then the first unchecked one. */
export function nextTask(plan) {
  const doing = plan.tasks.findIndex((t) => t.state === 'doing');
  if (doing !== -1) return doing;
  return plan.tasks.findIndex((t) => t.state === 'todo');
}

export function formatChecklist(plan) {
  const icon = { done: c.green('✔'), doing: c.yellow('▶'), blocked: c.magenta('?'), todo: c.gray('○') };
  const done = plan.tasks.filter((t) => t.state === 'done').length;
  return `${c.bold(plan.title || 'Plan')} ${c.gray(`· ${done}/${plan.tasks.length} done · ${plan.status}`)}\n` +
    plan.tasks.map((t, i) => `  ${icon[t.state]} ${i + 1}. ${t.state === 'done' ? c.gray(t.text) : t.text}${t.note ? c.gray(` (${t.note})`) : ''}`).join('\n');
}

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

// ---------- build-mode approval policy ----------

const SYSTEM_PKG = /(^|[;&|]\s*|\b(sudo)\s+)(apt(-get)?|dnf|yum|pacman|zypper|apk|brew|port|snap|flatpak|choco|winget|scoop)\b/;
const GLOBAL_INSTALL = /\b(npm|pnpm|yarn)\s+(i|install|add)\b[^|;&]*\s(-g|--global)\b|\byarn\s+global\b|\bpip3?\s+install\b[^|;&]*--user\b|\b(cargo|go)\s+install\b|\bgem\s+install\b/;
const NETWORK = /\b(curl|wget|ssh|scp|rsync|ftp|nc|telnet)\b|\bgit\s+(push|clone|fetch|pull)\b|\bnpm\s+publish\b|\bdocker\s+(push|login)\b/;

/**
 * In `ember build`, which commands may run without asking:
 *   'auto'   inside the project: builds, tests, project-local installs (npm install, pip in a venv)…
 *   'ask'    system packages, global installs, network tools, paths outside the project
 *   'danger' destructive commands (always typed confirmation)
 */
export function buildCommandPolicy(cmd, root) {
  const s = String(cmd || '').trim();
  if (!s) return 'ask';
  if (isDestructive(s)) return 'danger';
  if (SYSTEM_PKG.test(s) || GLOBAL_INSTALL.test(s)) return 'ask';
  if (NETWORK.test(s)) return 'ask';
  if (/\bpip3?\s+install\b/.test(s) && !/(\.venv|venv)\/bin\/pip|-m\s+venv|--target|requirements/.test(s) && !process.env.VIRTUAL_ENV) return 'ask';
  // Paths that leave the project: "..", "~", absolute paths outside root.
  if (/(^|[\s'"=])\.\.(\/|\s|$)/.test(s) || /(^|[\s'"=])~(\/|\s|$)/.test(s) || /\$HOME\b/.test(s)) return 'ask';
  for (const m of s.matchAll(/(?:^|[\s'"=])(\/[^\s'";|&]+)/g)) {
    const p = m[1];
    if (/^\/dev\/null$/.test(p)) continue;
    if (!isWithin(root, p)) return 'ask';
  }
  return 'auto';
}

// ---------- model calls (short, JSON) ----------

async function ask(agent, system, user, { signal, num_predict = 900 } = {}) {
  const r = await agent.client.chat({ model: agent.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], options: { temperature: 0.2, num_ctx: agent.cfg.numCtx, num_predict }, signal });
  dlog('plan-reply', { system: system.slice(0, 200), content: r.content });
  return r.content || '';
}

const Q_PROMPT = `You help plan a small software project. Ask the developer up to 5 short clarifying questions
about what matters most: who it is for, the main features or pages, the tech stack (or "you choose"), the look and feel, and anything unclear.
Reply with ONLY JSON: {"questions":["...","..."]}`;

const DEFAULT_QUESTIONS = [
  'Who is it for, and what should they be able to do?',
  'Which pages or main features do you want?',
  'Any tech stack you prefer? (Enter = Ember chooses something simple)',
  'How should it look? (colors, style, examples you like)'
];

const SPEC_PROMPT = (small) => `Write a build plan for the project below. Reply with ONLY JSON:
{"title":"short name","goal":"one or two sentences","spec":["Audience: ...","Features: ...","Pages: ...","Stack: ...","Style: ..."],"tasks":["...","..."]}
Tasks: ${small ? '4 to 8' : '4 to 12'} small steps in build order, each doable in one go and touching only 1-3 files
(e.g. "Create package.json with start and test scripts", "Create index.html with the header and nav"). Name the files in each task.
Prefer a simple stack (plain HTML/CSS/JS for websites, Node.js otherwise) unless the developer asked for something else.
Include a task that adds a basic test or check, and a last task that writes README.md with how to run it.`;

export function parseQuestions(text) {
  for (const o of findJsonObjects(String(text || ''))) if (Array.isArray(o.value?.questions)) return o.value.questions.map(String).map((q) => q.trim()).filter(Boolean).slice(0, 5);
  const lines = String(text || '').split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim()).filter((l) => /\?$/.test(l));
  return lines.slice(0, 5);
}

/** Parse the planner's spec reply. Accepts the JSON shape, or a markdown list of tasks as a fallback. */
export function parseSpec(text, idea = '') {
  const raw = String(text || '');
  for (const o of findJsonObjects(raw)) {
    const v = o.value;
    if (!v || !Array.isArray(v.tasks)) continue;
    const tasks = v.tasks.map((t) => (typeof t === 'string' ? t : t?.task || t?.title || t?.step || '')).map((t) => t.trim()).filter(Boolean).slice(0, 15);
    if (!tasks.length) continue;
    const spec = Array.isArray(v.spec) ? v.spec.map((s) => `- ${String(s).replace(/^[-*]\s*/, '')}`).join('\n')
      : v.spec && typeof v.spec === 'object' ? Object.entries(v.spec).map(([k, x]) => `- ${k[0].toUpperCase()}${k.slice(1)}: ${Array.isArray(x) ? x.join(', ') : x}`).join('\n')
        : String(v.spec || '');
    return { title: String(v.title || idea).slice(0, 80), goal: String(v.goal || idea), spec, tasks: tasks.map((t) => ({ text: t, state: 'todo', note: '' })) };
  }
  const tasks = raw.split('\n').map((l) => /^\s*(?:\d+[.)]|[-*]\s+(?:\[ \]\s+)?)\s*(.{8,})$/.exec(l)?.[1]?.trim()).filter(Boolean).slice(0, 15);
  if (tasks.length >= 2) return { title: idea.slice(0, 60), goal: idea, spec: '', tasks: tasks.map((t) => ({ text: t, state: 'todo', note: '' })) };
  return null;
}

// ---------- ember plan ----------

export async function planSession({ agent, ui, idea = '', signal, yes = false }) {
  const root = agent.root;
  const existing = loadPlan(root);
  if (existing && existing.tasks.length && !idea) {
    ui.print(formatChecklist(existing));
    ui.print(c.gray(`  ${path.relative(process.cwd(), planPath(root)) || planPath(root)} · edit it freely · ember build to continue`));
    if (existing.status === 'draft') return approveLoop({ agent, ui, plan: existing, answers: [], idea: existing.goal, signal, yes });
    return existing;
  }
  if (existing && existing.tasks.length && !yes) {
    const ok = await ui.confirm(`There is already a plan (${existing.title}). Replace it with a new one?`, { allowAlways: false });
    if (ok !== 'y') return existing;
  }
  if (!idea) idea = ((await ui.ask(`${c.yellow('?')} What would you like to build? Describe the app or website in your own words:\n  `)) || '').trim();
  if (!idea) { ui.print('Nothing to plan yet.'); return null; }

  ui.print(c.gray('  thinking of a few questions…'));
  let questions = [];
  try { questions = parseQuestions(await ask(agent, Q_PROMPT, idea, { signal, num_predict: 300 })); } catch (e) { if (signal?.aborted) throw e; dlog('error', { where: 'plan questions', message: e.message }); }
  if (!questions.length) questions = DEFAULT_QUESTIONS;
  const answers = [];
  if (yes || !ui.input?.isTTY && ui.closed) ui.print(c.gray('  (no questions asked: Ember chooses sensible defaults)'));
  else {
    ui.print(c.bold('A few questions') + c.gray(' (press Enter to let Ember decide):'));
    for (const q of questions) {
      const a = await ui.ask(`  ${c.yellow('?')} ${q} `);
      if (a === null) break;
      answers.push({ q, a: a.trim() || '(you decide)' });
    }
  }
  return draftAndApprove({ agent, ui, idea, answers, signal, yes });
}

async function draftAndApprove({ agent, ui, idea, answers, signal, yes, feedback = '' }) {
  ui.print(c.gray('  writing the plan…'));
  const brief = `Idea: ${idea}\n${answers.map((x) => `Q: ${x.q}\nA: ${x.a}`).join('\n')}${feedback ? `\nChanges the developer asked for: ${feedback}` : ''}`;
  let spec = null;
  for (let attempt = 0; attempt < 2 && !spec; attempt++) {
    try { spec = parseSpec(await ask(agent, SPEC_PROMPT(agent.isSmall?.()), brief, { signal, num_predict: 1000 }), idea); } catch (e) { if (signal?.aborted) throw e; }
  }
  if (!spec) {
    spec = { title: idea.slice(0, 60), goal: idea, spec: '', tasks: ['Create the project files and folder structure', 'Build the main page or entry point', 'Add the main features', 'Add a basic test or check', 'Write README.md with how to run it'].map((t) => ({ text: t, state: 'todo', note: '' })) };
    ui.warn('The model did not return a usable plan, so Ember wrote a generic one. Edit .ember/plan.md to make it yours.');
  }
  const plan = { ...spec, status: 'draft', questions: answers.filter((x) => x.a && x.a !== '(you decide)').map((x) => ({ q: x.q, a: x.a, open: false })), log: [`${stamp()} plan drafted`] };
  savePlan(agent.root, plan);
  return approveLoop({ agent, ui, plan, answers, idea, signal, yes });
}

async function approveLoop({ agent, ui, plan, answers, idea, signal, yes }) {
  for (;;) {
    ui.print('');
    ui.print(c.bold(`Plan: ${plan.title}`));
    if (plan.goal) ui.print(plan.goal);
    if (plan.spec) ui.print(c.gray(plan.spec));
    ui.print(formatChecklist(plan).split('\n').slice(1).join('\n'));
    ui.print(c.gray(`  saved to ${planPath(agent.root)}`));
    if (yes) { plan.status = 'approved'; break; }
    const a = await ui.ask(`${c.yellow('?')} Approve this plan? ${c.gray('[y]es / [e]dit the file, then Enter / [n]o / or type what to change')} `);
    if (a === null) break;
    const t = a.trim();
    if (/^(y|yes)$/i.test(t)) { plan.status = 'approved'; break; }
    if (/^(n|no)$/i.test(t) || !t) { ui.print(c.gray('  kept as a draft. Edit it, then ember plan (or /plan) to approve, or ember build to start.')); return plan; }
    if (/^(e|edit)$/i.test(t)) {
      await ui.ask(c.gray(`  edit ${planPath(agent.root)} in your editor, save, then press Enter… `));
      plan = loadPlan(agent.root) || plan;
      continue;
    }
    return draftAndApprove({ agent, ui, idea, answers, signal, yes, feedback: t });
  }
  plan.log.push(`${stamp()} plan ${plan.status}`);
  savePlan(agent.root, plan);
  if (plan.status === 'approved') ui.ok(`Plan approved. Run ${c.bold('ember build')} (or /build) and Ember will build it task by task.`);
  return plan;
}

// ---------- ember build ----------

const TASK_PROMPT = ({ plan, i, done, answers }) => `You are building this project on your own, one task at a time.
Project: ${plan.title}. ${plan.goal.slice(0, 400)}
${plan.spec ? `Spec:\n${plan.spec.slice(0, 700)}\n` : ''}${answers ? `Developer answers:\n${answers.slice(0, 500)}\n` : ''}${done.length ? `Already done: ${done.slice(-4).map((t) => t.text).join(' | ').slice(0, 500)}\n` : ''}
Now do ONLY task ${i + 1}/${plan.tasks.length}: ${plan.tasks[i].text}
Write files with write_file/edit_file (complete contents). Install project dependencies with run_command if this task needs them.
If you truly cannot continue without the developer's decision, reply with one line starting with "QUESTION:".
When the task is done, reply with one short sentence.`;

/** How to run what was built (best guess from the files). */
export function howToRun(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  try {
    if (has('package.json')) {
      const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const s = p.scripts || {};
      const run = s.dev ? 'npm run dev' : s.start ? 'npm start' : null;
      return [`npm install`, run, s.test ? 'npm test' : null].filter(Boolean).join(' && ') || 'npm install';
    }
  } catch { /* fall through */ }
  if (has('index.html')) return 'open index.html in your browser (or: ember preview)';
  for (const f of ['main.py', 'app.py']) if (has(f)) return `python3 ${f}`;
  return 'see README.md';
}

/**
 * Work through the approved plan. Auto-approves file writes and safe in-project commands
 * (see buildCommandPolicy); everything else still asks. Saves progress after every task.
 */
export async function buildSession({ agent, ui, signal, yes = false, maxFix = 2, preview = null }) {
  const root = agent.root;
  let plan = loadPlan(root);
  if (!plan || !plan.tasks.length) { ui.warn(`No plan yet. Start with ${c.bold('ember plan "your idea"')} (or /plan).`); return null; }
  if (plan.status === 'draft' && !yes) {
    ui.print(formatChecklist(plan));
    const ok = await ui.confirm('This plan is still a draft. Approve it and start building?', { allowAlways: false });
    if (ok !== 'y') return plan;
  }
  if (plan.status === 'done' && nextTask(plan) === -1) { ui.ok('Everything in the plan is done.'); ui.print(formatChecklist(plan)); return plan; }
  const resumed = plan.tasks.some((t) => t.state !== 'todo');
  plan.status = 'building';
  plan.log.push(`${stamp()} build ${resumed ? 'resumed' : 'started'}`);
  savePlan(root, plan);
  if (!isRepo(root)) { git(root, ['init', '-q']); agent.checkpoints.enabled = isRepo(root); if (agent.checkpoints.enabled) ui.print(c.gray('  (started a git repository so every task gets a checkpoint)')); }

  const ctx = agent.ctx;
  const prevPolicy = ctx.policy;
  ctx.policy = 'build';
  ui.print('');
  ui.print(c.bold().yellow('Ember is building') + c.gray(' · writes files and runs safe project commands without asking · asks before anything risky · type /pause + Enter to pause after this task · Ctrl+C stops now'));
  ui.print(formatChecklist(plan));
  const answers = plan.questions.filter((q) => q.a).map((q) => `${q.q} → ${q.a}`).join('\n');
  let paused = false;
  const asked = new Map();
  if (ui.input?.isTTY) ui._ensure?.(); // so "/pause" typed during the build is captured
  try {
    for (let i = nextTask(plan); i !== -1; i = nextTask(plan)) {
      if (signal?.aborted) throw new Error('aborted');
      if (ui.takePause?.()) { paused = true; break; }
      const task = plan.tasks[i];
      task.state = 'doing';
      savePlan(root, plan);
      ui.print('');
      ui.print(c.bold(`▶ Task ${i + 1}/${plan.tasks.length}: `) + task.text);
      try { agent.checkpoints.enabled && agent.checkpoints.create(`build task ${i + 1}: ${task.text}`); } catch { /* no checkpoint */ }
      const before = ctx.backups.length;
      agent.messages = []; // each task starts from a short, focused context
      const out = await agent.run(TASK_PROMPT({ plan, i, done: plan.tasks.filter((t) => t.state === 'done'), answers }), { signal, hints: true });
      const q = /^\s*QUESTION:\s*(.+)$/im.exec(out || '');
      if (q) {
        const question = q[1].trim();
        plan.questions.push({ q: question, a: '', open: true });
        let answer = null;
        asked.set(i, (asked.get(i) || 0) + 1);
        if (!yes && ui.input?.isTTY && asked.get(i) <= 2) answer = ((await ui.ask(`${c.magenta('?')} Ember asks: ${question}\n  ${c.gray('(answer, or Enter to skip this task for now)')} `)) || '').trim();
        if (answer) {
          plan.questions[plan.questions.length - 1] = { q: question, a: answer, open: false };
          task.state = 'todo'; task.note = '';
          savePlan(root, plan);
          continue; // retry the same task with the answer in the prompt
        }
        task.state = 'blocked'; task.note = question.slice(0, 120);
        plan.log.push(`${stamp()} task ${i + 1} blocked: ${question.slice(0, 120)}`);
        savePlan(root, plan);
        continue;
      }
      if (ctx.backups.length > before && detectChecks(root, agent.cfg).length) await agent.selfFix({ signal, maxAttempts: maxFix }).catch((e) => { if (signal?.aborted) throw e; });
      task.state = 'done'; task.note = '';
      const changed = ctx.backups.length - before;
      plan.log.push(`${stamp()} task ${i + 1} done${changed ? ` (${changed} file change${changed > 1 ? 's' : ''})` : ''}`);
      savePlan(root, plan);
      ui.print(c.gray(`  ✔ task ${i + 1}/${plan.tasks.length} done`));
    }
  } catch (e) {
    if (signal?.aborted || e.message === 'aborted') {
      plan.status = 'paused';
      plan.log.push(`${stamp()} stopped (Ctrl+C); run ember build to continue`);
      savePlan(root, plan);
      ui.warn(`Stopped. Progress is saved in .ember/plan.md; ${c.bold('ember build')} continues from task ${nextTask(plan) + 1}.`);
      ctx.policy = prevPolicy;
      return plan;
    }
    ctx.policy = prevPolicy;
    plan.status = 'paused';
    plan.log.push(`${stamp()} stopped by an error: ${e.message.slice(0, 160)}`);
    savePlan(root, plan);
    throw e;
  }
  ctx.policy = prevPolicy;
  if (paused) {
    plan.status = 'paused'; plan.log.push(`${stamp()} paused`); savePlan(root, plan);
    ui.ok(`Paused. ${c.bold('ember build')} (or /build) continues from task ${nextTask(plan) + 1}.`);
    return plan;
  }
  const blocked = plan.tasks.filter((t) => t.state === 'blocked');
  plan.status = blocked.length ? 'paused' : 'done';
  plan.log.push(`${stamp()} build ${plan.status === 'done' ? 'finished' : `stopped with ${blocked.length} blocked task(s)`}`);
  savePlan(root, plan);
  if (preview && plan.status === 'done') { try { await preview(); } catch { /* preview is optional */ } }
  ui.print('');
  ui.print(buildSummary(plan, root));
  return plan;
}

export function buildSummary(plan, root) {
  const done = plan.tasks.filter((t) => t.state === 'done');
  const blocked = plan.tasks.filter((t) => t.state === 'blocked');
  const open = plan.questions.filter((q) => q.open);
  return [
    c.bold().yellow(`Built: ${plan.title}`) + c.gray(` (${done.length}/${plan.tasks.length} tasks)`),
    ...done.map((t) => c.green('  ✔ ') + t.text),
    ...blocked.map((t) => c.magenta('  ? ') + `${t.text}${t.note ? c.gray(` (${t.note})`) : ''}`),
    '', `${c.bold('How to run it:')} ${howToRun(root)}`,
    ...(open.length ? ['', c.bold('Open questions:'), ...open.map((q) => `  - ${q.q}`), c.gray('  Answer them in .ember/plan.md (add "A: …"), mark the task "- [ ]" again, then ember build.')] : []),
    c.gray('  Undo everything from this build: /rollback (git checkpoints were saved before each task).')
  ].join('\n');
}
