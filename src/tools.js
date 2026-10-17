/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { resolveInside, isAllowlisted, isDestructive, commandKind } from './safety.js';
import { applyEdit } from './edit.js';
import { renderDiff, diffStats, c } from './ui.js';
import { emberHome, saveConfig } from './config.js';

const MAX_OUT = 12000;
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.ember', '__pycache__', '.venv']);

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } }
});

export const TOOL_DEFS = [
  fn('list_dir', 'List files and folders in a directory of the project (recursive up to depth).', {
    path: { type: 'string', description: 'Directory relative to the project root. Default "."' },
    depth: { type: 'integer', description: 'Recursion depth, 1-4. Default 2' }
  }),
  fn('read_file', 'Read a text file from the project. Returns numbered lines.', {
    path: { type: 'string' },
    start_line: { type: 'integer', description: '1-based first line (optional)' },
    end_line: { type: 'integer', description: 'Last line (optional)' }
  }, ['path']),
  fn('search', 'Search the project for a regex or text and return matching lines with file:line.', {
    pattern: { type: 'string' },
    path: { type: 'string', description: 'Subdirectory to search (optional)' },
    glob: { type: 'string', description: 'File glob filter such as *.js (optional)' }
  }, ['pattern']),
  fn('write_file', 'Create a new file or fully overwrite a file with the given content.', {
    path: { type: 'string' },
    content: { type: 'string' }
  }, ['path', 'content']),
  fn('edit_file', 'Edit a file by replacing an exact snippet. "search" must match the file exactly once.', {
    path: { type: 'string' },
    search: { type: 'string', description: 'Exact existing text to replace' },
    replace: { type: 'string', description: 'New text' },
    replace_all: { type: 'boolean' }
  }, ['path', 'search', 'replace']),
  fn('run_command', 'Run a shell command in the project directory (build, test, install, git, etc.).', {
    command: { type: 'string' },
    timeout_sec: { type: 'integer', description: 'Default 120' }
  }, ['command']),
  fn('update_plan', 'Create or update your step-by-step plan / todo list. Use for any multi-step task.', {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { step: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } },
        required: ['step', 'status']
      }
    }
  }, ['steps']),
  fn('remember', 'Save a short durable note about the user\'s preferences or this project so you do better next time. Only for lasting facts the user stated or clearly showed.', {
    note: { type: 'string' },
    scope: { type: 'string', enum: ['global', 'project'] }
  }, ['note'])
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.function.name);

function clip(s, n = MAX_OUT) {
  if (s.length <= n) return s;
  return s.slice(0, n / 2) + `\n… [${s.length - n} chars truncated] …\n` + s.slice(-n / 2);
}

function rel(ctx, abs) { return path.relative(ctx.root, abs) || '.'; }

function isBinary(buf) { return buf.subarray(0, 8000).includes(0); }

export function listDir(ctx, { path: p = '.', depth = 2 }) {
  const abs = resolveInside(ctx.root, p);
  const d = Math.min(Math.max(Number(depth) || 2, 1), 4);
  const lines = [];
  const walk = (dir, level, prefix) => {
    let ents = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !IGNORE.has(e.name));
    ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (lines.length > 500) return;
      lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory() && level < d) walk(path.join(dir, e.name), level + 1, prefix + '  ');
    }
  };
  walk(abs, 1, '');
  return lines.length ? lines.join('\n') : '(empty directory)';
}

export function readFile(ctx, { path: p, start_line, end_line }) {
  const abs = resolveInside(ctx.root, p);
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) return `(binary file, ${buf.length} bytes)`;
  const lines = buf.toString('utf8').split('\n');
  const s = Math.max(1, Number(start_line) || 1);
  const e = Math.min(lines.length, Number(end_line) || lines.length);
  const out = [];
  for (let i = s; i <= e; i++) out.push(`${String(i).padStart(4)}| ${lines[i - 1]}`);
  return clip(out.join('\n')) + (e < lines.length ? `\n(${lines.length - e} more lines)` : '');
}

let rgPath;
function hasRg() {
  if (rgPath === undefined) {
    const r = spawnSync('rg', ['--version'], { encoding: 'utf8' });
    rgPath = r.status === 0 ? 'rg' : null;
  }
  return rgPath;
}

function globToRe(g) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

export function searchJs(root, base, pattern, glob) {
  let re;
  try { re = new RegExp(pattern); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
  const gre = glob ? globToRe(glob) : null;
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (hits.length >= 200) return;
      if (IGNORE.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!gre || gre.test(e.name)) {
        let buf;
        try { buf = fs.readFileSync(p); } catch { continue; }
        if (buf.length > 2e6 || isBinary(buf)) continue;
        buf.toString('utf8').split('\n').forEach((line, i) => {
          if (hits.length < 200 && re.test(line)) hits.push(`${path.relative(root, p)}:${i + 1}: ${line.slice(0, 300)}`);
        });
      }
    }
  };
  walk(base);
  return hits;
}

export function search(ctx, { pattern, path: p = '.', glob }) {
  if (!pattern) throw new Error('pattern is required');
  const abs = resolveInside(ctx.root, p);
  if (hasRg() && !ctx.noRg) {
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '20', '--max-columns', '300'];
    if (glob) args.push('--glob', glob);
    args.push('-e', pattern, path.relative(ctx.root, abs) || '.');
    const r = spawnSync('rg', args, { cwd: ctx.root, encoding: 'utf8', maxBuffer: 10e6 });
    const out = (r.stdout || '').trim();
    if (r.status === 2 && !out) return `search error: ${r.stderr.trim()}`;
    const lines = out ? out.split('\n') : [];
    return lines.length ? clip(lines.slice(0, 200).join('\n')) : 'No matches.';
  }
  const hits = searchJs(ctx.root, abs, pattern, glob);
  return hits.length ? clip(hits.join('\n')) : 'No matches.';
}

function backup(ctx, abs, before) {
  const dir = path.join(emberHome(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  let file = null;
  if (before !== null) {
    file = path.join(dir, `${Date.now()}-${path.basename(abs)}`);
    fs.writeFileSync(file, before);
  }
  ctx.backups.push({ abs, before, file });
}

async function applyChange(ctx, abs, before, after, label) {
  const r = rel(ctx, abs);
  if (before === after) return `No changes needed in ${r}.`;
  ctx.ui.print('');
  ctx.ui.print(c.bold(`${label} ${r}`));
  ctx.ui.print(renderDiff(r, before, after));
  let ok = ctx.always.writes ? 'y' : await ctx.ui.confirm(`Apply this change to ${r}?`);
  if (ok === 'a') { ctx.always.writes = true; ok = 'y'; }
  if (ok !== 'y') {
    ctx.session.events.push({ type: 'rejected', tool: 'file', detail: `${label} ${r}` });
    const why = ctx.ui.yes ? '' : await ctx.ui.ask(c.gray('  (optional) why not / what should change? ') );
    return `User rejected the change to ${r}.${why && why.trim() ? ` Feedback: ${why.trim()}` : ' Ask what they want instead.'}`;
  }
  backup(ctx, abs, before);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, after);
  ctx.session.writes.set(abs, after);
  ctx.session.events.push({ type: 'accepted', tool: 'file', detail: `${label} ${r}` });
  const st = diffStats(before, after);
  ctx.ui.ok(`${before === null ? 'Created' : 'Updated'} ${r} ${c.green('+' + st.add)} ${c.red('-' + st.del)}`);
  return `${before === null ? 'Created' : 'Updated'} ${r} (+${st.add} -${st.del}).`;
}

export async function writeFile(ctx, { path: p, content }) {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const abs = resolveInside(ctx.root, p);
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  return applyChange(ctx, abs, before, content, before === null ? 'Create' : 'Overwrite');
}

export async function editFile(ctx, { path: p, search: s, replace, replace_all }) {
  const abs = resolveInside(ctx.root, p);
  if (!fs.existsSync(abs)) throw new Error(`${p} does not exist. Use write_file to create it.`);
  const before = fs.readFileSync(abs, 'utf8');
  const after = applyEdit(before, s, replace, { replaceAll: !!replace_all });
  return applyChange(ctx, abs, before, after, 'Edit');
}

export async function runCommand(ctx, { command, timeout_sec = 120 }) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('command is required');
  const cmd = command.trim();
  const allowed = isAllowlisted(cmd, ctx.cfg.allowlist);
  ctx.ui.print('');
  ctx.ui.print(c.bold('Run ') + c.yellow(`$ ${cmd}`) + (allowed ? c.gray('  (allowlisted)') : ''));
  if (isDestructive(cmd)) {
    const ok = await ctx.ui.confirmDangerous(`"${cmd}" looks destructive.`);
    if (!ok) {
      ctx.session.events.push({ type: 'rejected', tool: 'command', detail: cmd });
      return 'User blocked this destructive command. Do not retry it; find a safer approach or ask the user.';
    }
  } else if (!allowed && !ctx.always.commands.has(commandKind(cmd))) {
    let ok = await ctx.ui.confirm('Run this command?');
    if (ok === 'a') { ctx.always.commands.add(commandKind(cmd)); ok = 'y'; }
    const suggest = ctx.ui.yes ? null : ctx.memory?.approval(cmd, ok === 'y');
    if (ok !== 'y') {
      ctx.session.events.push({ type: 'rejected', tool: 'command', detail: cmd });
      return 'User declined to run this command.';
    }
    ctx.session.events.push({ type: 'accepted', tool: 'command', detail: cmd });
    if (suggest) await suggestAllowlist(ctx, suggest);
  }
  return execShell(ctx, cmd, timeout_sec);
}

async function suggestAllowlist(ctx, kind) {
  ctx.memory.markSuggested(kind);
  const a = await ctx.ui.confirm(`You keep approving ${c.bold(kind)}. Add "${kind}" to your allowlist so Ember runs it without asking?`, { allowAlways: false });
  if (a === 'y') {
    ctx.cfg.allowlist = [...new Set([...(ctx.cfg.allowlist || []), kind])];
    saveConfig(ctx.cfg);
    ctx.ui.ok(`Added "${kind}" to the allowlist in ${path.join(emberHome(), 'config.json')}`);
  }
}

export function execShell(ctx, cmd, timeoutSec = 120) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
    const env = { ...process.env, EMBER: '1' };
    delete env.NODE_TEST_CONTEXT; // don't let a parent node:test runner swallow the child's results
    const child = spawn(shell, args, { cwd: ctx.root, env });
    let out = '';
    const onData = (d) => { const s = d.toString(); out += s; if (!ctx.quietCommands) ctx.ui.write(c.gray(s)); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { child.kill('SIGTERM'); out += `\n[ember] timed out after ${timeoutSec}s`; }, Math.max(1, timeoutSec) * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(`exit code ${code}\n${clip(out.trim() || '(no output)')}`);
    });
    child.on('error', (e) => { clearTimeout(timer); resolve(`failed to start: ${e.message}`); });
  });
}

export function updatePlan(ctx, { steps }) {
  if (!Array.isArray(steps)) throw new Error('steps must be an array');
  ctx.plan = steps.map((s) => ({ step: String(s.step ?? s), status: s.status || 'pending' }));
  ctx.ui.print('');
  ctx.ui.print(formatPlan(ctx.plan));
  return 'Plan updated.';
}

export function formatPlan(plan) {
  if (!plan?.length) return c.gray('(no plan yet)');
  const icon = { done: c.green('✔'), in_progress: c.yellow('▶'), pending: c.gray('○') };
  return c.bold('Plan') + '\n' + plan.map((s) => `  ${icon[s.status] || icon.pending} ${s.status === 'done' ? c.gray(s.step) : s.step}`).join('\n');
}

export function rememberTool(ctx, { note, scope }) {
  if (!ctx.memory?.enabled) return 'Memory is turned off; nothing saved.';
  const sc = scope === 'project' ? 'project' : 'global';
  const r = ctx.memory.remember(note, { scope: sc, source: 'learned' });
  if (!r.added) return 'Not saved: it conflicts with something the user said directly.';
  ctx.ui.print(c.gray(`  (remembered${sc === 'project' ? ' for this project' : ''}: ${note} · /forget to undo)`));
  return 'Saved.';
}

export async function executeTool(ctx, name, args) {
  switch (name) {
    case 'list_dir': return listDir(ctx, args);
    case 'read_file': return readFile(ctx, args);
    case 'search': return search(ctx, args);
    case 'write_file': return writeFile(ctx, args);
    case 'edit_file': return editFile(ctx, args);
    case 'run_command': return runCommand(ctx, args);
    case 'update_plan': return updatePlan(ctx, args);
    case 'remember': return rememberTool(ctx, args);
    default: throw new Error(`Unknown tool "${name}". Available: ${TOOL_NAMES.join(', ')}`);
  }
}

/** Revert the most recent file change. */
export function undoLast(ctx) {
  const b = ctx.backups.pop();
  if (!b) return null;
  if (b.before === null) { if (fs.existsSync(b.abs)) fs.rmSync(b.abs); }
  else fs.writeFileSync(b.abs, b.before);
  ctx.session.writes.delete(b.abs);
  return { path: rel(ctx, b.abs), deleted: b.before === null };
}

export const homeDir = os.homedir();
