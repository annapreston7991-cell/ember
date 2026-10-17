/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Detect a repo's conventions (editorconfig, prettier, eslint, package.json, sample files)
// so Ember writes code that matches what is already there. Read-only and local.
import fs from 'node:fs';
import path from 'node:path';
import { makeNote } from './memory.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.ember', '__pycache__', '.venv']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.css', '.html', '.ejs', '.vue', '.svelte']);

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function exists(root, f) { return fs.existsSync(path.join(root, f)); }

function sampleFiles(root, max = 25) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= max || depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, depth + 1); }
      else if (CODE_EXT.has(path.extname(e.name))) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

export function analyzeSource(texts) {
  let tabs = 0, spaces = 0, single = 0, double = 0, semi = 0, noSemi = 0;
  const widths = {};
  for (const t of texts) {
    for (const line of t.split('\n').slice(0, 400)) {
      const ind = line.match(/^(\s+)\S/);
      if (ind) {
        if (ind[1].startsWith('\t')) tabs++;
        else { spaces++; const w = ind[1].length; if (w <= 8) widths[w] = (widths[w] || 0) + 1; }
      }
      const s = line.trim();
      if (!s || s.startsWith('//') || s.startsWith('*') || s.startsWith('#')) continue;
      single += (s.match(/'[^'\n]*'/g) || []).length;
      double += (s.match(/"[^"\n]*"/g) || []).length;
      if (/[\w)\]'"`]$/.test(s) && !/[{(,[]$/.test(s)) noSemi++;
      if (/;$/.test(s)) semi++;
    }
  }
  let indent = null;
  if (tabs + spaces > 20) {
    if (tabs > spaces) indent = 'tabs';
    else {
      const w2 = widths[2] || 0, w4 = widths[4] || 0;
      indent = w2 >= w4 * 0.6 ? '2 spaces' : '4 spaces';
    }
  }
  const quotes = single + double > 20 ? (single > double * 1.5 ? 'single' : double > single * 1.5 ? 'double' : null) : null;
  const semicolons = semi + noSemi > 20 ? (semi > noSemi ? true : semi < noSemi * 0.2 ? false : null) : null;
  return { indent, quotes, semicolons };
}

/** Returns an array of "detected" notes (never persisted; recomputed each session). */
export function detectRepoStyle(root) {
  const facts = [];
  const add = (t) => facts.push(makeNote(t, { source: 'detected', scope: 'project' }));

  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    add(`Node.js project${pkg.type === 'module' ? ' using ES modules (import/export)' : ' using CommonJS (require) unless a file says otherwise'}`);
    const fw = ['next', 'react', 'vue', 'svelte', 'express', 'fastify', 'koa', 'nestjs', 'electron', 'ejs', 'tailwindcss', 'typescript', 'sqlite3', 'better-sqlite3', 'prisma']
      .filter((d) => deps[d] || deps[`@${d}/core`]);
    if (fw.length) add(`Uses ${fw.join(', ')}`);
    const test = pkg.scripts?.test;
    if (test && !/no test specified/.test(test)) add(`Run tests with \`npm test\` (${test.slice(0, 60)})`);
    const tf = ['vitest', 'jest', 'mocha', 'ava', 'tap'].find((d) => deps[d]);
    if (tf) add(`Test framework: ${tf}`);
    if (pkg.prettier) facts.push(...prettierNotes(pkg.prettier, add));
  }
  if (exists(root, 'pnpm-lock.yaml')) add('Package manager: pnpm');
  else if (exists(root, 'yarn.lock')) add('Package manager: yarn');
  else if (exists(root, 'bun.lockb')) add('Package manager: bun');
  else if (exists(root, 'package-lock.json')) add('Package manager: npm');
  if (exists(root, 'tsconfig.json')) add('TypeScript is configured (tsconfig.json)');
  if (exists(root, 'pyproject.toml') || exists(root, 'requirements.txt')) add('Python code present (pyproject/requirements)');

  for (const f of ['.prettierrc', '.prettierrc.json']) {
    const pr = readJson(path.join(root, f));
    if (pr) { prettierNotes(pr, add); break; }
  }
  const eslint = ['eslint.config.js', 'eslint.config.mjs', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs'].find((f) => exists(root, f));
  if (eslint) add(`ESLint config present (${eslint}); keep code lint-clean`);

  let ecIndent = null;
  try {
    const ec = fs.readFileSync(path.join(root, '.editorconfig'), 'utf8');
    const style = ec.match(/indent_style\s*=\s*(\w+)/)?.[1];
    const size = ec.match(/indent_size\s*=\s*(\d+)/)?.[1];
    if (style) { ecIndent = style === 'tab' ? 'tabs' : `${size || 2} spaces`; add(`Indent with ${ecIndent} (.editorconfig)`); }
  } catch { /* none */ }

  const texts = sampleFiles(root).map((p) => { try { return fs.readFileSync(p, 'utf8').slice(0, 20000); } catch { return ''; } });
  const s = analyzeSource(texts);
  if (s.indent && !ecIndent) add(`Existing code indents with ${s.indent}`);
  if (s.quotes) add(`Existing code mostly uses ${s.quotes} quotes`);
  if (s.semicolons === true) add('Existing code ends statements with semicolons');
  if (s.semicolons === false) add('Existing code omits semicolons');
  return facts;
}

function prettierNotes(pr, add) {
  if (typeof pr !== 'object') return [];
  if (pr.useTabs) add('Indent with tabs (prettier)');
  else if (pr.tabWidth) add(`Indent with ${pr.tabWidth} spaces (prettier)`);
  if (pr.singleQuote !== undefined) add(`Use ${pr.singleQuote ? 'single' : 'double'} quotes (prettier)`);
  if (pr.semi !== undefined) add(pr.semi ? 'Use semicolons (prettier)' : 'No semicolons (prettier)');
  return [];
}
