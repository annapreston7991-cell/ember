/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Git checkpoints that never touch your branch, index or HEAD.
// Each checkpoint is a commit object stored under refs/ember/<session>/<n>,
// built from a throwaway index, so your staging area is left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function git(root, args, { env, input } = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, input, maxBuffer: 50e6 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

export function isRepo(root) {
  return git(root, ['rev-parse', '--is-inside-work-tree']).out === 'true';
}

export function repoTop(root) {
  return git(root, ['rev-parse', '--show-toplevel']).out || root;
}

function withTempIndex(root, fn) {
  const idx = path.join(os.tmpdir(), `ember-index-${process.pid}-${Date.now()}`);
  try { return fn({ GIT_INDEX_FILE: idx }); } finally { fs.rmSync(idx, { force: true }); }
}

/** Snapshot the working tree (tracked + untracked, minus ignored) into a commit. Returns its sha. */
export function snapshot(root, message = 'ember checkpoint') {
  const top = repoTop(root);
  return withTempIndex(top, (env) => {
    const head = git(top, ['rev-parse', '--verify', '-q', 'HEAD']).out;
    if (head) git(top, ['read-tree', head], { env });
    const add = git(top, ['add', '-A', '.'], { env });
    if (!add.ok) throw new Error(`git add failed: ${add.err}`);
    const tree = git(top, ['write-tree'], { env });
    if (!tree.ok) throw new Error(`git write-tree failed: ${tree.err}`);
    const args = ['commit-tree', tree.out, '-m', message];
    if (head) args.splice(2, 0, '-p', head);
    const commitEnv = { ...env, GIT_AUTHOR_NAME: 'Ember', GIT_AUTHOR_EMAIL: 'ember@localhost', GIT_COMMITTER_NAME: 'Ember', GIT_COMMITTER_EMAIL: 'ember@localhost' };
    const c = git(top, args, { env: commitEnv });
    if (!c.ok) throw new Error(`git commit-tree failed: ${c.err}`);
    return c.out;
  });
}

export class Checkpoints {
  constructor(root, sessionId = new Date().toISOString().replace(/[:.]/g, '-')) {
    this.root = root;
    this.enabled = isRepo(root);
    this.session = sessionId;
    this.list = [];
  }

  create(label) {
    if (!this.enabled) return null;
    const sha = snapshot(this.root, `ember checkpoint: ${label}`.slice(0, 200));
    const ref = `refs/ember/${this.session}/${this.list.length + 1}`;
    git(this.root, ['update-ref', ref, sha]);
    this.list.push({ sha, ref, label, ts: new Date().toISOString() });
    return sha;
  }

  /** Files that differ between a checkpoint and the current working tree. */
  changedSince(sha) {
    const now = snapshot(this.root, 'ember compare');
    const r = git(this.root, ['diff', '--name-status', '--no-renames', sha, now]);
    return r.out ? r.out.split('\n').map((l) => { const [st, ...f] = l.split('\t'); return { status: st, file: f.join('\t') }; }) : [];
  }

  /** Restore the working tree to a checkpoint (default: the first one of this session). */
  restore(sha = this.list[0]?.sha) {
    if (!sha) throw new Error('No checkpoint in this session yet.');
    const top = repoTop(this.root);
    const changes = this.changedSince(sha);
    withTempIndex(top, (env) => {
      git(top, ['read-tree', sha], { env });
      const co = git(top, ['checkout-index', '-a', '-f'], { env });
      if (!co.ok) throw new Error(`restore failed: ${co.err}`);
    });
    for (const ch of changes) if (ch.status === 'A') fs.rmSync(path.join(top, ch.file), { force: true });
    return changes;
  }
}

/** Diff of everything not yet committed (for commit messages). */
export function pendingDiff(root, maxChars = 12000) {
  const stat = git(root, ['status', '--short']).out;
  const diff = git(root, ['diff', 'HEAD']).out || git(root, ['diff']).out;
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']).out;
  return { stat, diff: diff.slice(0, maxChars), untracked, empty: !stat };
}

export function commitAll(root, message) {
  const add = git(root, ['add', '-A']);
  if (!add.ok) throw new Error(add.err);
  const c = git(root, ['commit', '-m', message]);
  if (!c.ok) throw new Error(c.err || c.out);
  return git(root, ['rev-parse', '--short', 'HEAD']).out;
}

export function cleanCommitMessage(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```\w*\n?|```$/g, '').trim();
  t = t.replace(/^(commit message:|message:)\s*/i, '').trim();
  t = t.replace(/^["']|["']$/g, '').trim();
  const lines = t.split('\n');
  lines[0] = lines[0].slice(0, 72);
  return lines.join('\n').trim() || 'Update files';
}
