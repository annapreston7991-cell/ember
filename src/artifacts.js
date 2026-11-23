/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import path from 'node:path';

export class ArtifactManager {
  constructor(root, sessionId = 'default') {
    this.root = root;
    this.sessionId = sessionId;
    this.dir = path.join(root, '.ember', 'artifacts', sessionId);
    this.ensureDir();
  }

  ensureDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  create({ title, summary, content, requestFeedback = false, userFacing = true }) {
    this.ensureDir();
    const cleanTitle = (title || 'artifact').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'artifact';
    const filename = `${cleanTitle}.md`;
    const fullPath = path.join(this.dir, filename);

    // Frontmatter metadata header
    const frontmatter = [
      '---',
      `title: "${(title || '').replace(/"/g, '\\"')}"`,
      `summary: "${(summary || '').replace(/"/g, '\\"')}"`,
      `user_facing: ${Boolean(userFacing)}`,
      `request_feedback: ${Boolean(requestFeedback)}`,
      `created_at: "${new Date().toISOString()}"`,
      '---',
      '',
      content.trim(),
      ''
    ].join('\n');

    fs.writeFileSync(fullPath, frontmatter, 'utf8');

    return {
      filename,
      title,
      summary,
      path: path.relative(this.root, fullPath),
      fullPath,
      requestFeedback: Boolean(requestFeedback),
      userFacing: Boolean(userFacing)
    };
  }

  list() {
    this.ensureDir();
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md'));
    return files.map((f) => {
      const fullPath = path.join(this.dir, f);
      const text = fs.readFileSync(fullPath, 'utf8');
      const meta = parseArtifact(text, f);
      return {
        filename: f,
        ...meta,
        path: path.relative(this.root, fullPath)
      };
    });
  }

  get(filename) {
    const fullPath = path.join(this.dir, filename.endsWith('.md') ? filename : `${filename}.md`);
    if (!fs.existsSync(fullPath)) return null;
    const text = fs.readFileSync(fullPath, 'utf8');
    return {
      filename: path.basename(fullPath),
      fullPath,
      path: path.relative(this.root, fullPath),
      ...parseArtifact(text, path.basename(fullPath)),
      raw: text
    };
  }
}

export function parseArtifact(text, defaultTitle) {
  let title = defaultTitle;
  let summary = '';
  let userFacing = true;
  let requestFeedback = false;
  let content = text;

  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const header = text.slice(3, end);
      content = text.slice(end + 4).trim();
      const t = header.match(/title:\s*"([^"]+)"/i);
      const s = header.match(/summary:\s*"([^"]+)"/i);
      const uf = header.match(/user_facing:\s*(true|false)/i);
      const rf = header.match(/request_feedback:\s*(true|false)/i);
      if (t) title = t[1];
      if (s) summary = s[1];
      if (uf) userFacing = uf[1] === 'true';
      if (rf) requestFeedback = rf[1] === 'true';
    }
  }

  return { title, summary, userFacing, requestFeedback, content };
}
