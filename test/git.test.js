/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.js';
import { git, isRepo, Checkpoints, commitAll, cleanCommitMessage, pendingDiff } from '../src/git.js';

function repo() {
  const root = tmpdir('ember-git-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'bee\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'secret.env\n');
  commitAll(root, 'init');
  return root;
}

test('checkpoint + rollback restores edits, deletions and removes new files', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'staged change\n');
  git(root, ['add', 'a.txt']);                     // user has something staged
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'mine\n');
  fs.writeFileSync(path.join(root, 'secret.env'), 'KEY=1\n');
  const head = git(root, ['rev-parse', 'HEAD']).out;
  const staged = git(root, ['diff', '--cached', '--name-only']).out;

  const cp = new Checkpoints(root, 'test');
  assert.ok(cp.enabled);
  cp.create('task 1');
  assert.match(git(root, ['for-each-ref', 'refs/ember/']).out, /refs\/ember\/test\/1/);
  // checkpoint must not move HEAD or touch the index
  assert.equal(git(root, ['rev-parse', 'HEAD']).out, head);
  assert.equal(git(root, ['diff', '--cached', '--name-only']).out, staged);

  // "Ember" changes things
  fs.writeFileSync(path.join(root, 'a.txt'), 'ember edit\n');
  fs.rmSync(path.join(root, 'b.txt'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'new.js'), 'x\n');
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'ember changed mine\n');

  const changes = cp.changedSince(cp.list[0].sha).map((c) => c.status + ' ' + c.file).sort();
  assert.deepEqual(changes, ['A src/new.js', 'D b.txt', 'M a.txt', 'M untracked.txt']);
  cp.restore();
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'staged change\n');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'bee\n');
  assert.equal(fs.readFileSync(path.join(root, 'untracked.txt'), 'utf8'), 'mine\n');
  assert.ok(!fs.existsSync(path.join(root, 'src', 'new.js')));
  assert.equal(fs.readFileSync(path.join(root, 'secret.env'), 'utf8'), 'KEY=1\n'); // ignored files untouched
  assert.equal(git(root, ['rev-parse', 'HEAD']).out, head);
});

test('checkpoints work in a repo with no commits yet, and are disabled outside git', () => {
  const root = tmpdir('ember-git0-');
  git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, 'x.txt'), '1');
  const cp = new Checkpoints(root, 's');
  cp.create('first');
  fs.writeFileSync(path.join(root, 'x.txt'), '2');
  cp.restore();
  assert.equal(fs.readFileSync(path.join(root, 'x.txt'), 'utf8'), '1');
  assert.equal(new Checkpoints(tmpdir('ember-nogit-')).enabled, false);
  assert.equal(isRepo(tmpdir('ember-nogit-')), false);
});

test('commit helpers', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'c.txt'), 'new\n');
  const d = pendingDiff(root);
  assert.ok(!d.empty);
  assert.match(d.untracked, /c\.txt/);
  const sha = commitAll(root, 'Add c.txt');
  assert.ok(sha);
  assert.equal(git(root, ['log', '-1', '--format=%s']).out, 'Add c.txt');
  assert.ok(pendingDiff(root).empty);
  assert.equal(cleanCommitMessage('```\nCommit message: "Add login page"\n```'), 'Add login page');
  assert.equal(cleanCommitMessage('x'.repeat(100)).length, 72);
  assert.equal(cleanCommitMessage(''), 'Update files');
});
