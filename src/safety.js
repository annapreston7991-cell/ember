/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Resolve a user/model supplied path and make sure it stays inside root.
 * Throws if the path escapes (via .., absolute paths, or symlinks).
 */
export function resolveInside(root, p) {
  if (typeof p !== 'string' || p.trim() === '') throw new Error('Path is required');
  if (p.includes('\0')) throw new Error('Invalid path');
  const realRoot = fs.realpathSync(root);
  p = p.trim().replace(/^(['"`])(.*)\1$/, '$2');
  // "~/x" means the home folder: fine when the project is (inside) home, e.g. ember run from ~.
  if (/^~(?=$|[\/])/.test(p)) p = path.join(os.homedir(), p.slice(1));
  let abs = path.resolve(realRoot, p);
  // Models often write project files as "/hello.py" or "/src/app.js". When such an absolute path
  // is outside the project and its top folder does not exist on this machine, treat it as
  // relative to the project instead of failing the write.
  if (path.isAbsolute(p) && !isWithin(realRoot, abs) && !isWithin(fs.realpathSync(os.homedir()), abs)) {
    const top = abs.split(path.sep).filter(Boolean)[0];
    if (top && !fs.existsSync(path.join(path.parse(abs).root, top))) abs = path.resolve(realRoot, '.' + path.sep + path.relative(path.parse(abs).root, abs));
  }
  if (!isWithin(realRoot, abs)) {
    let hint = '';
    if (path.isAbsolute(p)) hint = ` Use a path relative to the project, like "${path.basename(p)}".`;
    throw new Error(`Path "${p}" is outside the project directory (${realRoot}).${hint}`);
  }
  // Follow symlinks for the deepest existing ancestor.
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  if (!isWithin(realRoot, realProbe)) throw new Error(`Path "${p}" resolves outside the project directory (symlink)`);
  return abs;
}

export function isWithin(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const DESTRUCTIVE = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\*|\.\.?)(\s|\/?$|\/\*)/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b.*\bof=\/dev\//,
  />\s*\/dev\/(sd|nvme|hd|vd)/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bchmod\s+-R\s+0?777\s+\//,
  /\bchown\s+-R\s+.*\s+\/(\s|$)/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bgit\s+push\b.*(--force|-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
  /\bsudo\b/,
  /\bfind\b.*\s-delete\b/,
  /\bdrop\s+(database|table)\b/i
];

export function isDestructive(cmd) {
  return DESTRUCTIVE.some((re) => re.test(cmd));
}

const META = /[;&|`$<>(){}\n\\]/;

/** True when cmd is a simple command matching an allowlist entry (prefix by whole words). */
export function isAllowlisted(cmd, allowlist = []) {
  const c = cmd.trim().replace(/\s+/g, ' ');
  if (!c || META.test(c)) return false;
  if (isDestructive(c)) return false;
  return allowlist.some((entry) => {
    const e = entry.trim().replace(/\s+/g, ' ');
    return c === e || c.startsWith(e + ' ');
  });
}

/** A short "kind" for a command, used for adaptive approval suggestions. */
export function commandKind(cmd) {
  const toks = cmd.trim().split(/\s+/);
  if (!toks[0]) return '';
  const multi = ['git', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'go', 'python', 'python3', 'pip', 'docker', 'make'];
  if (multi.includes(toks[0]) && toks[1] && !toks[1].startsWith('-')) {
    if (['run', 'exec'].includes(toks[1]) && toks[2]) return toks.slice(0, 3).join(' ');
    return toks.slice(0, 2).join(' ');
  }
  return toks[0];
}

/** Whether a command kind is safe enough to ever suggest allowlisting. */
export function isSuggestable(cmd) {
  const c = cmd.trim();
  return !!c && !META.test(c) && !isDestructive(c) && !/^(rm|mv|cp|chmod|chown|kill|pkill|dd)\b/.test(c);
}
