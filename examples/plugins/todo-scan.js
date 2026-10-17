/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Example Ember plugin: finds TODO / FIXME comments in the project.
// Install: copy this file to ~/.ember/plugins/ (all projects) or <project>/.ember/plugins/ (one project).
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.ember']);

export default {
  name: 'todo_scan',
  description: 'List TODO and FIXME comments in the project (file:line: text). Use it to find unfinished work.',
  parameters: {
    type: 'object',
    properties: { tag: { type: 'string', description: 'Optional: only this tag, e.g. FIXME' } },
    required: []
  },
  readOnly: true, // read-only tools run without an approval prompt

  async run(args, ember) {
    const tag = (args.tag || 'TODO|FIXME').replace(/[^A-Za-z|]/g, '');
    const re = new RegExp(`\\b(${tag})\\b[:\\s](.*)`);
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name) || hits.length >= 200) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (fs.statSync(p).size < 1e6) {
          fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            const m = line.match(re);
            if (m) hits.push(`${path.relative(ember.root, p)}:${i + 1}: ${m[1]} ${m[2].trim()}`);
          });
        }
      }
    };
    walk(ember.root);
    return hits.length ? hits.join('\n') : 'No TODO/FIXME comments found.';
  }
};
