/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SkillsManager, parseSkillFrontmatter } from '../src/skills.js';

test('skills: parses frontmatter correctly', () => {
  const md = `---
name: dart-testing
description: Guidelines and patterns for writing Dart unit tests
---

# Dart Unit Testing
Always use package:test.
`;
  const res = parseSkillFrontmatter(md, 'default-name');
  assert.equal(res.name, 'dart-testing');
  assert.equal(res.description, 'Guidelines and patterns for writing Dart unit tests');
  assert.match(res.body, /# Dart Unit Testing/);
});

test('skills: scans and reads project skills', () => {
  const root = path.join(os.tmpdir(), `ember-skills-test-${Date.now()}`);
  const skillDir = path.join(root, '.ember', 'skills', 'cloudflare-workers');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: cf-workers
description: Deploy serverless apps on Cloudflare Workers
---
# Cloudflare Workers Guide
Use wrangler.jsonc and modern ES modules.
`);

  const mgr = new SkillsManager(root);
  const list = mgr.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'cf-workers');
  assert.equal(list[0].scope, 'project');

  const content = mgr.readContent('cf-workers');
  assert.match(content, /wrangler\.jsonc/);

  const promptText = mgr.formatForPrompt();
  assert.match(promptText, /cf-workers: Deploy serverless apps on Cloudflare Workers/);

  fs.rmSync(root, { recursive: true, force: true });
});
