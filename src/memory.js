/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Ember's local learning layer. Everything here lives on the user's machine:
//   ~/.ember/profile.json      global preferences + approval habits
//   <project>/.ember/memory.md per-project notes (plain Markdown, hand-editable)
// No network calls, no telemetry.
import fs from 'node:fs';
import { isPro, requirePro } from './pro.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { emberHome } from './config.js';
import { commandKind, isSuggestable } from './safety.js';

// Higher wins when two notes carry the same timestamp, and model-inferred
// ("learned"/"detected") notes can never override something the user said.
const SOURCE_RANK = { detected: 0, learned: 1, said: 2, explicit: 3 };
const USER_SOURCES = new Set(['said', 'explicit']);

export function normalizeText(t) {
  return String(t).toLowerCase().replace(/[`"'’.,!;:()]/g, '').replace(/\s+/g, ' ').trim();
}

const KEY_RULES = [
  [/\b(tabs?|\d+[- ]space|spaces)\b.*\b(indent|indentation)\b|\b(indent|indentation)\b.*\b(tabs?|\d+[- ]space|spaces)\b|\buse (tabs|\d+ spaces)\b/i, 'style.indent'],
  [/\b(single|double)[- ]quotes?\b/i, 'style.quotes'],
  [/\bsemicolons?\b/i, 'style.semicolons'],
  [/\b(camelcase|snake_case|pascalcase|kebab-case)\b/i, 'style.naming'],
  [/\btrailing commas?\b/i, 'style.trailingCommas'],
  [/\b(npm|pnpm|yarn|bun)\b.*\b(package manager|for install|to install)\b|\buse (pnpm|yarn|bun|npm)\b/i, 'tooling.packageManager'],
  [/\b(jest|vitest|mocha|node:test|node --test|pytest|ava|tap)\b/i, 'testing.framework'],
  [/\b(write|add)\b.*\btests?\b|\btests?\b.*\b(first|always|never|skip)\b/i, 'testing.habit'],
  [/\b(typescript|javascript|plain js|\bts\b)\b.*\b(over|instead|prefer|use)\b|\b(prefer|use)\b.*\b(typescript|javascript)\b/i, 'lang.primary'],
  [/\b(esm|es modules|commonjs|require\(\))\b/i, 'lang.modules'],
  [/\b(concise|brief|short|terse|verbose|detailed|longer)\b.*\b(answers?|explanations?|replies|responses|output)\b|\b(answers?|explanations?|replies|responses)\b.*\b(concise|brief|short|terse|verbose|detailed)\b/i, 'tone.verbosity'],
  [/\b(emoji|emojis)\b/i, 'tone.emoji'],
  [/\bcommit messages?\b/i, 'workflow.commits']
];

/** Derive a conflict key so newer statements about the same thing replace older ones. */
export function inferKey(text) {
  for (const [re, key] of KEY_RULES) if (re.test(text)) return key;
  const m = normalizeText(text).match(/^(?:i\s+)?(?:please\s+)?(?:always|never|dont|do not|dont ever|stop)\s+(.+)$/);
  if (m) return 'rule:' + m[1].replace(/^(ever|again)\s+/, '').slice(0, 80);
  return null;
}

export function categoryOf(key) {
  if (!key) return 'general';
  if (key.startsWith('rule:')) return 'rule';
  return key.split('.')[0];
}

export function makeNote(text, { source = 'explicit', scope = 'global', ts = new Date().toISOString(), key, category } = {}) {
  const clean = String(text).trim().replace(/\s+/g, ' ').slice(0, 300);
  const k = key === undefined ? inferKey(clean) : key;
  return {
    id: crypto.createHash('sha1').update(normalizeText(clean)).digest('hex').slice(0, 8),
    text: clean, key: k, category: category || categoryOf(k), scope, source, ts
  };
}

function wordSet(t) {
  return new Set(normalizeText(t).split(' ').filter((w) => w.length > 2));
}

export function similarity(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Does incoming note b beat existing note a when they conflict? */
export function wins(b, a) {
  if (USER_SOURCES.has(a.source) && !USER_SOURCES.has(b.source)) return false;
  if (b.ts !== a.ts) return b.ts > a.ts;
  return (SOURCE_RANK[b.source] ?? 0) >= (SOURCE_RANK[a.source] ?? 0);
}

/**
 * Add a note to a list, resolving conflicts. Returns { notes, replaced, added }.
 * - same key           → newer wins (user-stated notes beat model-inferred ones)
 * - same / near text   → merged, keeping the newest timestamp
 */
export function addNote(notes, note) {
  const list = [...notes];
  const replaced = [];
  const nt = normalizeText(note.text);
  for (let i = list.length - 1; i >= 0; i--) {
    const old = list[i];
    const sameKey = note.key && old.key === note.key;
    const sameText = normalizeText(old.text) === nt || similarity(old.text, note.text) >= 0.8;
    if (!sameKey && !sameText) continue;
    if (!wins(note, old)) return { notes: list, replaced: [], added: false };
    replaced.push(old);
    list.splice(i, 1);
  }
  list.push(note);
  return { notes: list, replaced: replaced.filter((r) => normalizeText(r.text) !== nt), added: true };
}

export function mergeNotes(...lists) {
  const all = lists.flat().filter(Boolean).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  let out = [];
  for (const n of all) out = addNote(out, n).notes;
  return out;
}

/** Remove notes matching an id or text fragment. Returns { notes, removed }. */
export function forgetNotes(notes, query) {
  const q = normalizeText(query);
  if (!q) return { notes, removed: [] };
  const removed = [], kept = [];
  for (const n of notes) {
    if (n.id === query.trim() || normalizeText(n.text).includes(q) || (n.key && n.key === query.trim())) removed.push(n);
    else kept.push(n);
  }
  return { notes: kept, removed };
}

/** Keep the list bounded: user-stated notes first, then newest. */
export function compactNotes(notes, maxNotes = 60) {
  const merged = mergeNotes(notes);
  if (merged.length <= maxNotes) return merged;
  const ranked = [...merged].sort((a, b) =>
    (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0) || (a.ts < b.ts ? 1 : -1));
  const keep = new Set(ranked.slice(0, maxNotes));
  return merged.filter((n) => keep.has(n));
}

/** Pick the notes most relevant to the current request and render them compactly. */
export function renderMemory({ global = [], project = [], detected = [], query = '', maxChars = 1800 } = {}) {
  const qWords = wordSet(query);
  const now = Date.now();
  const score = (n) => {
    let s = n.key ? 3 : 0;                         // keyed preferences always matter
    s += (SOURCE_RANK[n.source] ?? 0) * 0.5;
    for (const w of wordSet(n.text)) if (qWords.has(w)) s += 1.5;
    const ageDays = (now - Date.parse(n.ts || 0)) / 864e5;
    s += Math.max(0, 2 - ageDays / 30);            // fade older notes
    return s;
  };
  const sections = [
    ['User preferences (newer notes win on conflict)', global],
    ['This project', project],
    ['Detected from this repo', detected]
  ];
  const ordered = [];
  for (const [title, list] of sections) {
    const sorted = [...list].sort((a, b) => score(b) - score(a));
    ordered.push({ title, items: sorted });
  }
  let out = '';
  for (const { title, items } of ordered) {
    if (!items.length) continue;
    let block = `### ${title}\n`;
    let any = false;
    for (const n of items) {
      const line = `- ${n.text}\n`;
      if (out.length + block.length + line.length > maxChars) break;
      block += line; any = true;
    }
    if (any) out += block;
  }
  return out.trim();
}

// ---------- statements in chat ----------

const PREF_RE = /\b(i (?:really |strongly )?(?:prefer|like|want|hate|dislike|love)|always|never|don'?t ever|do not ever|please don'?t|from now on|stop (?:using|adding|doing))\b/i;

/** Pull durable preference statements out of what the user typed. */
export function detectStatedPreferences(message) {
  const out = [];
  if (!message || message.startsWith('/')) return out;
  const sentences = message.split(/(?<=[.!?])\s+|\n+/);
  for (let s of sentences) {
    s = s.trim();
    if (s.length < 8 || s.length > 220 || s.endsWith('?')) continue;
    if (/\bnever ?mind\b/i.test(s)) continue;
    if (!PREF_RE.test(s)) continue;
    // Only keep statements that read as standing preferences, not one-off task text.
    if (/\b(this time|right now|for now|today)\b/i.test(s)) continue;
    const scope = /\b(this (project|repo|codebase)|here|in this)\b/i.test(s) ? 'project' : 'global';
    out.push({ text: s.replace(/[.!]+$/, ''), scope });
  }
  return out;
}

// ---------- approval habits ----------

export function recordApproval(approvals, cmd, approved, { suggestAfter = 3, now = new Date().toISOString() } = {}) {
  const kind = commandKind(cmd);
  if (!kind) return { approvals, suggest: null };
  const a = { ...approvals };
  const cur = { approved: 0, denied: 0, streak: 0, suggested: false, ...(a[kind] || {}) };
  if (approved) { cur.approved++; cur.streak++; } else { cur.denied++; cur.streak = 0; }
  cur.last = now;
  a[kind] = cur;
  const suggest = approved && !cur.suggested && cur.streak >= suggestAfter && isSuggestable(cmd) ? kind : null;
  return { approvals: a, suggest };
}

// ---------- storage ----------

export function profilePath() { return path.join(emberHome(), 'profile.json'); }
export function projectMemoryPath(root) { return path.join(root, '.ember', 'memory.md'); }
/** Team memory (Ember Pro): curated notes committed to the repo and shared with everyone on it. */
export function teamMemoryPath(root) { return path.join(root, '.ember', 'team.md'); }

export function emptyProfile() { return { version: 1, notes: [], approvals: {}, updated: null }; }

export function loadProfile() {
  try {
    const p = JSON.parse(fs.readFileSync(profilePath(), 'utf8'));
    return { ...emptyProfile(), ...p, notes: Array.isArray(p.notes) ? p.notes : [] };
  } catch { return emptyProfile(); }
}

export function saveProfile(profile) {
  fs.mkdirSync(emberHome(), { recursive: true });
  profile.updated = new Date().toISOString();
  fs.writeFileSync(profilePath(), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
}

const META_RE = /\s*<!--\s*ember:([^>]*)-->\s*$/;

export function parseMemoryMd(text, { fallbackTs = new Date(0).toISOString() } = {}) {
  const notes = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*[-*]\s+(.+)$/);
    if (!m) continue;
    let body = m[1];
    const meta = {};
    const mm = body.match(META_RE);
    if (mm) {
      body = body.slice(0, mm.index);
      for (const part of mm[1].split(',')) {
        const [k, ...v] = part.split('=');
        if (k && v.length) meta[k.trim()] = v.join('=').trim();
      }
    }
    if (!body.trim()) continue;
    notes.push(makeNote(body, {
      source: meta.src || 'explicit', scope: 'project', ts: meta.ts || fallbackTs,
      key: meta.key === undefined ? undefined : (meta.key || null)
    }));
  }
  return notes;
}

export function serializeMemoryMd(notes) {
  const lines = [
    '# Ember project memory',
    '',
    '<!-- Managed by Ember, kept only on this machine. Edit freely: one note per "- " line. -->',
    ''
  ];
  for (const n of notes) {
    lines.push(`- ${n.text} <!-- ember: ts=${n.ts}, src=${n.source}${n.key ? `, key=${n.key}` : ''} -->`);
  }
  return lines.join('\n') + '\n';
}

export function loadNotesFile(p) {
  try { const st = fs.statSync(p); return parseMemoryMd(fs.readFileSync(p, 'utf8'), { fallbackTs: st.mtime.toISOString() }); } catch { return []; }
}

export function loadProjectNotes(root) {
  const p = projectMemoryPath(root);
  try {
    const st = fs.statSync(p);
    return parseMemoryMd(fs.readFileSync(p, 'utf8'), { fallbackTs: st.mtime.toISOString() });
  } catch { return []; }
}

export function saveProjectNotes(root, notes) {
  const p = projectMemoryPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, serializeMemoryMd(notes));
}

/** Stateful wrapper used by the agent and the CLI. */
export class Memory {
  constructor(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    this.enabled = cfg.memory?.enabled !== false;
    this.profile = this.enabled ? loadProfile() : emptyProfile();
    this.project = this.enabled ? loadProjectNotes(root) : [];
    this.teamOn = this.enabled && isPro(cfg);
    this.team = this.teamOn ? loadNotesFile(teamMemoryPath(root)) : [];
    this.detected = [];
  }

  get maxNotes() { return this.cfg.memory?.maxNotes ?? 60; }

  remember(text, { scope = 'global', source = 'explicit' } = {}) {
    if (!this.enabled) return { added: false, replaced: [] };
    if (scope === 'team') {
      requirePro(this.cfg, 'team-memory');
      const note = makeNote(text, { scope: 'project', source });
      const r = addNote(this.team, note);
      this.team = compactNotes(r.notes, this.maxNotes);
      fs.mkdirSync(path.dirname(teamMemoryPath(this.root)), { recursive: true });
      fs.writeFileSync(teamMemoryPath(this.root), serializeMemoryMd(this.team));
      return { ...r, note };
    }
    const note = makeNote(text, { scope, source });
    if (scope === 'project') {
      const r = addNote(this.project, note);
      this.project = compactNotes(r.notes, this.maxNotes);
      saveProjectNotes(this.root, this.project);
      return { ...r, note };
    }
    const r = addNote(this.profile.notes, note);
    this.profile.notes = compactNotes(r.notes, this.maxNotes);
    saveProfile(this.profile);
    return { ...r, note };
  }

  forget(query) {
    const g = forgetNotes(this.profile.notes, query);
    const p = forgetNotes(this.project, query);
    if (g.removed.length) { this.profile.notes = g.notes; saveProfile(this.profile); }
    if (p.removed.length) { this.project = p.notes; saveProjectNotes(this.root, this.project); }
    return [...g.removed, ...p.removed];
  }

  approval(cmd, approved) {
    if (!this.enabled) return null;
    const r = recordApproval(this.profile.approvals, cmd, approved, { suggestAfter: this.cfg.approvals?.suggestAfter ?? 3 });
    this.profile.approvals = r.approvals;
    saveProfile(this.profile);
    return r.suggest;
  }

  markSuggested(kind) {
    if (this.profile.approvals[kind]) this.profile.approvals[kind].suggested = true;
    saveProfile(this.profile);
  }

  forPrompt(query) {
    if (!this.enabled) return '';
    return renderMemory({
      global: this.profile.notes, project: [...this.team.map((n) => ({ ...n, text: n.text.startsWith('(team) ') ? n.text : `(team) ${n.text}` })), ...this.project], detected: this.detected,
      query, maxChars: this.cfg.memory?.maxPromptChars ?? 1800
    });
  }

  replaceAll({ global, project }) {
    if (global) { this.profile.notes = compactNotes(global, this.maxNotes); saveProfile(this.profile); }
    if (project) { this.project = compactNotes(project, this.maxNotes); saveProjectNotes(this.root, this.project); }
  }

  static reset({ root, global = true, project = true } = {}) {
    const removed = [];
    if (global && fs.existsSync(profilePath())) { fs.rmSync(profilePath()); removed.push(profilePath()); }
    if (project && root && fs.existsSync(projectMemoryPath(root))) { fs.rmSync(projectMemoryPath(root)); removed.push(projectMemoryPath(root)); }
    return removed;
  }
}
