/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.EMBER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-home-'));
const M = await import('../src/memory.js');
const { makeNote, addNote, mergeNotes, forgetNotes, compactNotes, inferKey, renderMemory, detectStatedPreferences,
  recordApproval, parseMemoryMd, serializeMemoryMd, Memory } = M;
const { analyzeSource } = await import('../src/style.js');

const t = (d) => new Date(Date.UTC(2026, 0, d)).toISOString();

test('conflict keys are inferred for common preferences', () => {
  assert.equal(inferKey('I prefer tabs for indentation'), 'style.indent');
  assert.equal(inferKey('Use 2 spaces'), 'style.indent');
  assert.equal(inferKey('Always use single quotes'), 'style.quotes');
  assert.equal(inferKey('Never use semicolons'), 'style.semicolons');
  assert.equal(inferKey('Use pnpm'), 'tooling.packageManager');
  assert.equal(inferKey('Keep explanations short'), 'tone.verbosity');
  assert.equal(inferKey('Always run the linter before committing'), inferKey('Never run the linter before committing'));
  assert.equal(inferKey('The API lives in server.js'), null);
});

test('newer note wins on the same key', () => {
  let notes = [makeNote('Use tabs for indentation', { ts: t(1) })];
  const r = addNote(notes, makeNote('Indent with 2 spaces', { ts: t(5) }));
  assert.equal(r.added, true);
  assert.deepEqual(r.notes.map((n) => n.text), ['Indent with 2 spaces']);
  assert.equal(r.replaced[0].text, 'Use tabs for indentation');
  // An older statement arriving late does not overwrite the newer one.
  const r2 = addNote(r.notes, makeNote('Use tabs for indentation', { ts: t(2) }));
  assert.equal(r2.added, false);
  assert.deepEqual(r2.notes.map((n) => n.text), ['Indent with 2 spaces']);
});

test('always/never about the same thing conflict, newer wins', () => {
  const merged = mergeNotes([makeNote('Never add comments to code', { ts: t(3) })], [makeNote('Always add comments to code', { ts: t(1) })]);
  assert.deepEqual(merged.map((n) => n.text), ['Never add comments to code']);
});

test('model-learned notes cannot override what the user said', () => {
  const said = makeNote('Use double quotes', { ts: t(1), source: 'explicit' });
  const learned = makeNote('Use single quotes', { ts: t(9), source: 'learned' });
  const r = addNote([said], learned);
  assert.equal(r.added, false);
  assert.equal(r.notes[0].text, 'Use double quotes');
  // but a newer user statement does override
  const r2 = addNote([said], makeNote('Use single quotes', { ts: t(9), source: 'said' }));
  assert.equal(r2.notes[0].text, 'Use single quotes');
});

test('duplicates and near-duplicates merge, keeping the newest timestamp', () => {
  const a = makeNote('Prefers Express for web servers', { ts: t(1) });
  const b = makeNote('prefers express for web servers.', { ts: t(4) });
  const merged = mergeNotes([a], [b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].ts, t(4));
});

test('forget by words or id', () => {
  const notes = [makeNote('Use pnpm'), makeNote('Likes dark mode UIs')];
  const r = forgetNotes(notes, 'dark mode');
  assert.equal(r.removed.length, 1);
  assert.deepEqual(r.notes.map((n) => n.text), ['Use pnpm']);
  assert.equal(forgetNotes(notes, notes[0].id).removed[0].text, 'Use pnpm');
});

test('compaction bounds size, keeps user-stated notes first', () => {
  const notes = [];
  for (let i = 0; i < 30; i++) notes.push(makeNote(`learned fact number ${i} about widgets${i}`, { ts: t(i + 1), source: 'learned', key: null }));
  notes.push(makeNote('User said keep functions small', { ts: t(1), source: 'explicit', key: null }));
  const out = compactNotes(notes, 10);
  assert.equal(out.length, 10);
  assert.ok(out.some((n) => n.source === 'explicit'));
  assert.ok(out.some((n) => n.text.includes('number 29')));
  assert.ok(!out.some((n) => n.text.includes('number 0 ')));
});

test('prompt rendering is capped and prefers relevant notes', () => {
  const global = [];
  for (let i = 0; i < 100; i++) global.push(makeNote(`note ${i} about topic${i} with some padding text`, { ts: t(1), key: null }));
  global.push(makeNote('Database work should use better-sqlite3', { ts: t(1), key: null }));
  const out = renderMemory({ global, query: 'add a sqlite database table using better-sqlite3', maxChars: 400 });
  assert.ok(out.length <= 400);
  assert.ok(out.includes('better-sqlite3'));
});

test('stated preferences are detected from chat, one-offs are not', () => {
  const p = detectStatedPreferences('Add a login page. I prefer Tailwind over plain CSS. Never use var in this project.');
  assert.deepEqual(p.map((x) => x.text), ['I prefer Tailwind over plain CSS', 'Never use var in this project']);
  assert.equal(p[1].scope, 'project');
  assert.equal(detectStatedPreferences('never mind, do it for now').length, 0);
  assert.equal(detectStatedPreferences('Should I always use async?').length, 0);
  assert.equal(detectStatedPreferences('/remember always use tabs').length, 0);
});

test('adaptive approvals suggest allowlisting after a streak, once', () => {
  let a = {};
  let s;
  for (let i = 0; i < 2; i++) ({ approvals: a, suggest: s } = recordApproval(a, 'npm test', true, { suggestAfter: 3 }));
  assert.equal(s, null);
  ({ approvals: a, suggest: s } = recordApproval(a, 'npm test -- --watch', true, { suggestAfter: 3 }));
  assert.equal(s, 'npm test');
  a['npm test'].suggested = true;
  ({ suggest: s } = recordApproval(a, 'npm test', true, { suggestAfter: 3 }));
  assert.equal(s, null);
  // a decline resets the streak, and unsafe kinds are never suggested
  let b = {};
  for (let i = 0; i < 5; i++) ({ approvals: b, suggest: s } = recordApproval(b, 'rm build.log', true));
  assert.equal(s, null);
});

test('memory.md round-trips and tolerates hand-written lines', () => {
  const notes = [makeNote('Use pnpm here', { ts: t(2), scope: 'project' })];
  const md = serializeMemoryMd(notes) + '- Hand written note without metadata\n';
  const back = parseMemoryMd(md, { fallbackTs: t(3) });
  assert.equal(back.length, 2);
  assert.equal(back[0].text, 'Use pnpm here');
  assert.equal(back[0].ts, t(2));
  assert.equal(back[0].key, 'tooling.packageManager');
  assert.equal(back[1].ts, t(3));
  assert.equal(back[1].source, 'explicit');
});

test('Memory persists globally and per project, honors opt-out, and resets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-proj-'));
  const cfg = { memory: { enabled: true, maxNotes: 60, maxPromptChars: 1800 } };
  const m = new Memory(root, cfg);
  m.remember('Use 4 spaces for indentation');
  m.remember('This repo deploys with a Cloudflare Tunnel', { scope: 'project' });
  const m2 = new Memory(root, cfg);
  assert.equal(m2.profile.notes.length, 1);
  assert.equal(m2.project.length, 1);
  assert.match(m2.forPrompt('fix indentation'), /4 spaces/);
  const off = new Memory(root, { memory: { enabled: false } });
  assert.equal(off.forPrompt('x'), '');
  assert.equal(off.remember('anything').added, false);
  const removed = Memory.reset({ root });
  assert.equal(removed.length, 2);
  assert.equal(new Memory(root, cfg).profile.notes.length, 0);
});

test('repo style detection from source', () => {
  const code = Array.from({ length: 30 }, (_, i) => `function f${i}() {\n  return 'x';\n}`).join('\n');
  assert.deepEqual(analyzeSource([code]), { indent: '2 spaces', quotes: 'single', semicolons: true });
  const tabs = Array.from({ length: 30 }, () => 'if (a) {\n\tb = "y"\n}').join('\n');
  const s = analyzeSource([tabs]);
  assert.equal(s.indent, 'tabs');
  assert.equal(s.quotes, 'double');
});
