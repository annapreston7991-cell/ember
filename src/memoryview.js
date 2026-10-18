/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Memory, profilePath, projectMemoryPath, serializeMemoryMd, parseMemoryMd } from './memory.js';
import { detectRepoStyle } from './style.js';
import { loadConfig, saveConfig } from './config.js';
import { c } from './ui.js';

const SRC = { explicit: 'you', said: 'you said', learned: 'learned', detected: 'detected' };

function line(n) {
  const when = (n.ts || '').slice(0, 10);
  return `  ${c.gray(n.id)} ${n.text} ${c.gray(`(${SRC[n.source] || n.source}${when && !when.startsWith('1970') ? ', ' + when : ''})`)}`;
}

export function showMemory(ui, memory) {
  if (!memory.enabled) { ui.print(c.yellow('Memory is off.') + ' Turn it on with: ember memory on'); return; }
  ui.print(c.bold('Your preferences') + c.gray(`  ${profilePath()}`));
  ui.print(memory.profile.notes.length ? memory.profile.notes.map(line).join('\n') : c.gray('  (nothing yet — try /remember I use 2-space indentation)'));
  ui.print(c.bold('This project') + c.gray(`  ${projectMemoryPath(memory.root)}`));
  ui.print(memory.project.length ? memory.project.map(line).join('\n') : c.gray('  (nothing yet)'));
  if (memory.teamOn || memory.team?.length) {
    ui.print(c.bold('Team (Ember Pro)') + c.gray(`  ${path.join(memory.root, '.ember', 'team.md')} — commit it to share`));
    ui.print(memory.team.length ? memory.team.map(line).join('\n') : c.gray('  (nothing yet — /remember --team <note>)'));
  }
  const det = memory.detected?.length ? memory.detected : detectRepoStyle(memory.root);
  ui.print(c.bold('Detected from this repo') + c.gray('  (re-checked every session, not stored)'));
  ui.print(det.length ? det.map((n) => `  · ${n.text}`).join('\n') : c.gray('  (nothing detected)'));
}

export function showPrefs(ui, memory, cfg) {
  ui.print(c.bold('Preferences'));
  const keyed = memory.profile.notes.concat(memory.project).filter((n) => n.key);
  if (keyed.length) {
    const byCat = {};
    for (const n of keyed) (byCat[n.category] ||= []).push(n);
    for (const [cat, list] of Object.entries(byCat)) ui.print(`  ${c.cyan(cat.padEnd(10))} ${list.map((n) => n.text).join(' · ')}`);
  } else ui.print(c.gray('  (no style/tooling preferences recorded yet)'));
  const ap = Object.entries(memory.profile.approvals || {}).sort((a, b) => b[1].approved - a[1].approved).slice(0, 8);
  ui.print(c.bold('Approval habits'));
  ui.print(ap.length ? ap.map(([k, v]) => `  ${k.padEnd(18)} ${c.green(v.approved + ' approved')} ${c.red(v.denied + ' declined')}`).join('\n') : c.gray('  (none yet)'));
  ui.print(c.bold('Settings'));
  ui.print(`  memory ${cfg.memory?.enabled !== false ? c.green('on') : c.yellow('off')} · auto-learn ${cfg.memory?.autoLearn !== false ? 'on' : 'off'} · prompt cap ${cfg.memory?.maxPromptChars} chars · allowlist: ${cfg.allowlist.join(', ')}`);
}

function editInEditor(file) {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  const r = spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status === 0;
}

export async function memoryCommand({ ui, root, args, yes }) {
  const cfg = loadConfig();
  const sub = args[0] || 'show';
  const rest = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  if (sub === 'off' || sub === 'on') {
    cfg.memory = { ...cfg.memory, enabled: sub === 'on' };
    saveConfig(cfg);
    ui.ok(`Memory is now ${sub}.${sub === 'off' ? ' Ember will not read or write any memory. Existing notes are kept until you run: ember memory reset' : ''}`);
    return;
  }
  if (sub === 'reset') {
    const g = !flags.has('--project'), p = !flags.has('--global');
    const ok = yes ? 'y' : await ui.confirm(`Delete ${g && p ? 'ALL Ember memory (global profile + this project)' : g ? 'your global profile' : 'this project\'s memory'}?`, { allowAlways: false });
    if (ok !== 'y') return ui.print('Nothing deleted.');
    const removed = Memory.reset({ root, global: g, project: p });
    ui.ok(removed.length ? `Deleted ${removed.join(', ')}` : 'There was nothing to delete.');
    return;
  }
  const memory = new Memory(root, { ...cfg, memory: { ...cfg.memory, enabled: true } });
  switch (sub) {
    case 'show': memory.detected = detectRepoStyle(root); return showMemory(ui, memory);
    case 'prefs': return showPrefs(ui, memory, cfg);
    case 'path': ui.print(profilePath()); ui.print(projectMemoryPath(root)); return;
    case 'remember': {
      if (!rest) return ui.error('Usage: ember memory remember [--project|--team] <note>');
      let r;
      try { r = memory.remember(rest, { scope: flags.has('--team') ? 'team' : flags.has('--project') ? 'project' : 'global' }); }
      catch (e) { return ui.warn(e.message); }
      ui.ok(`Remembered: ${rest}${r.replaced?.length ? c.gray(` (replaces: ${r.replaced.map((x) => x.text).join('; ')})`) : ''}`);
      return;
    }
    case 'forget': {
      if (!rest) return ui.error('Usage: ember memory forget <id or words>');
      const removed = memory.forget(rest);
      ui.print(removed.length ? removed.map((n) => c.red('  - ') + n.text).join('\n') : 'No matching notes.');
      return;
    }
    case 'edit': {
      if (flags.has('--project')) {
        const p = projectMemoryPath(root);
        if (!fs.existsSync(p)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, serializeMemoryMd([])); }
        editInEditor(p);
        return ui.ok(`Saved ${p}`);
      }
      const tmp = path.join(os.tmpdir(), `ember-profile-${process.pid}.md`);
      fs.writeFileSync(tmp, serializeMemoryMd(memory.profile.notes).replace('# Ember project memory', '# Ember global preferences'));
      if (!editInEditor(tmp)) return ui.error('Editor exited with an error; nothing changed.');
      const notes = parseMemoryMd(fs.readFileSync(tmp, 'utf8'), { fallbackTs: new Date().toISOString() }).map((n) => ({ ...n, scope: 'global' }));
      fs.rmSync(tmp, { force: true });
      memory.replaceAll({ global: notes });
      return ui.ok(`Saved ${notes.length} note(s) to ${profilePath()}`);
    }
    default:
      ui.print(`Usage: ember memory [show|prefs|remember <note>|forget <words>|edit [--project]|reset [--global|--project]|on|off|path]`);
  }
}
