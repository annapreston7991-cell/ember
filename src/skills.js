/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { emberHome } from './config.js';

export class SkillsManager {
  constructor(root) {
    this.root = root;
    this.skills = new Map();
    this.reload();
  }

  reload() {
    this.skills.clear();
    const dirs = [
      { dir: path.join(emberHome(), 'skills'), scope: 'global' },
      { dir: path.join(this.root, '.ember', 'skills'), scope: 'project' }
    ];

    for (const { dir, scope } of dirs) {
      if (!fs.existsSync(dir)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const skillMd = path.join(dir, ent.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          try {
            const content = fs.readFileSync(skillMd, 'utf8');
            const meta = parseSkillFrontmatter(content, ent.name);
            this.skills.set(meta.name, {
              ...meta,
              scope,
              folder: path.join(dir, ent.name),
              file: skillMd,
              body: meta.body
            });
          } catch {
            /* ignore unparseable skill */
          }
        }
      }
    }
  }

  list() {
    return Array.from(this.skills.values()).map((s) => ({
      name: s.name,
      description: s.description,
      scope: s.scope
    }));
  }

  get(name) {
    if (!name || typeof name !== 'string') return null;
    return this.skills.get(name.trim().toLowerCase()) || null;
  }

  readContent(name) {
    const s = this.get(name);
    if (!s) return null;
    return fs.readFileSync(s.file, 'utf8');
  }

  formatForPrompt() {
    const list = this.list();
    if (!list.length) return '';
    const lines = list.map((s) => `- ${s.name}: ${s.description}`);
    return `Available skills (call load_skill to view step-by-step procedures):\n${lines.join('\n')}`;
  }
}

export function parseSkillFrontmatter(content, fallbackName) {
  let name = fallbackName.toLowerCase();
  let description = 'Specialized skill instructions';
  let body = content;

  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) {
      const header = content.slice(3, end);
      body = content.slice(end + 4).trim();
      const nMatch = header.match(/name:\s*([^\n]+)/i);
      const dMatch = header.match(/description:\s*([^\n]+)/i);
      if (nMatch) name = nMatch[1].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (dMatch) description = dMatch[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }

  return { name, description, body };
}
