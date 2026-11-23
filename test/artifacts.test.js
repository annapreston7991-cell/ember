/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ArtifactManager, parseArtifact } from '../src/artifacts.js';

test('artifacts: creates and parses artifact with frontmatter', () => {
  const root = path.join(os.tmpdir(), `ember-artifacts-test-${Date.now()}`);
  const mgr = new ArtifactManager(root, 'session-123');

  const art = mgr.create({
    title: 'Migration Plan',
    summary: 'Plan to upgrade Ember architecture',
    content: '## Steps\n1. Async tasks\n2. Skills\n3. Artifacts',
    requestFeedback: true
  });

  assert.equal(art.filename, 'migration-plan.md');
  assert.equal(art.requestFeedback, true);

  const list = mgr.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Migration Plan');
  assert.equal(list[0].summary, 'Plan to upgrade Ember architecture');

  const fetched = mgr.get('migration-plan');
  assert.ok(fetched);
  assert.equal(fetched.title, 'Migration Plan');
  assert.match(fetched.content, /## Steps/);

  fs.rmSync(root, { recursive: true, force: true });
});
