/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Local project index: file map + symbols (+ optional embeddings from a local Ollama
// embedding model), stored in <project>/.ember/index/. Updated incrementally by mtime/size/hash.
// Used to point the model at the right files before it starts reading.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const INDEX_VERSION = 1;
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.ember', '__pycache__', '.venv', 'venv', 'target', 'vendor', '.cache', '.turbo', '.svelte-kit', 'out']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.css', '.scss', '.html', '.ejs', '.vue', '.svelte', '.sh', '.yml', '.yaml', '.toml', '.sql', '.txt', '.env.example']);
const MAX_FILE = 400 * 1024;
const CHUNK_LINES = 60;

export function indexDir(root) { return path.join(root, '.ember', 'index'); }

const wanted = (f) => !f.split(/[\\/]/).some((seg) => IGNORE_DIRS.has(seg))
  && (TEXT_EXT.has(path.extname(f).toLowerCase()) || /(^|\/)(Dockerfile|Makefile|README)$/.test(f))
  && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f);

/** List project files: git-aware (respects .gitignore) with a walker fallback. */
export function listFiles(root, max = 5000) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 50e6 });
  let files;
  if (r.status === 0) files = r.stdout.split('\n').filter(Boolean);
  else {
    files = [];
    const walk = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (files.length >= max) return;
        if (IGNORE_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.env.example')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p); else if (wanted(path.relative(root, p))) files.push(path.relative(root, p));
      }
    };
    walk(root);
  }
  return files.filter(wanted).slice(0, max);
}

const SYMBOL_RULES = {
  js: [
    [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, 'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function'],
    [/^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/, 'type'],
    [/^\s*(?:app|router)\.(get|post|put|patch|delete|use)\(\s*['"`]([^'"`]+)/, 'route'],
    [/^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/, 'method']
  ],
  py: [[/^\s*def\s+([A-Za-z_]\w*)/, 'function'], [/^\s*class\s+([A-Za-z_]\w*)/, 'class'], [/^@(?:app|router)\.(get|post|put|delete|route)\(\s*['"]([^'"]+)/, 'route']],
  go: [[/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function'], [/^type\s+([A-Za-z_]\w*)/, 'type']],
  rs: [[/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/, 'function'], [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, 'type']],
  md: [[/^(#{1,3})\s+(.+)/, 'heading']],
  generic: [[/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|def|function|func|fn)\s+([A-Za-z_]\w*)/, 'symbol']]
};

function langOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte'].includes(ext)) return 'js';
  if (ext === '.py') return 'py';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rs';
  if (ext === '.md') return 'md';
  return 'generic';
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor']);

export function extractSymbols(text, file) {
  const rules = SYMBOL_RULES[langOf(file)] || SYMBOL_RULES.generic;
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < 200; i++) {
    for (const [re, kind] of rules) {
      const m = lines[i].match(re);
      if (!m) continue;
      const name = kind === 'route' ? `${m[1].toUpperCase()} ${m[2]}` : kind === 'heading' ? m[2].trim() : m[1];
      if (!name || KEYWORDS.has(name)) continue;
      out.push({ name: name.slice(0, 80), kind, line: i + 1 });
      break;
    }
  }
  return out;
}

export function tokenize(s) {
  return String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && w.length < 40);
}

function chunk(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) out.push({ start: i + 1, end: Math.min(lines.length, i + CHUNK_LINES), text: lines.slice(i, i + CHUNK_LINES).join('\n') });
  return out;
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

export function loadIndex(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(indexDir(root), 'index.json'), 'utf8'));
    if (j.version === INDEX_VERSION) return j;
  } catch { /* none */ }
  return { version: INDEX_VERSION, files: {}, embedModel: null, updated: null };
}

export function loadVectors(root) {
  try { return JSON.parse(fs.readFileSync(path.join(indexDir(root), 'vectors.json'), 'utf8')); } catch { return { model: null, chunks: {} }; }
}

function save(root, index, vectors) {
  const dir = indexDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(root, '.ember', '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'index/\ncache/\n');
  index.updated = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  if (vectors) fs.writeFileSync(path.join(dir, 'vectors.json'), JSON.stringify(vectors));
}

export const encodeVec = (v) => Buffer.from(new Float32Array(v).buffer).toString('base64');
export const decodeVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4); };

/**
 * Build or update the index. embed: optional async (texts[]) => vectors[] (e.g. Ollama /api/embed).
 * Returns stats { files, changed, removed, symbols, embedded, ms }.
 */
export async function updateIndex(root, { embed = null, embedModel = null, onProgress = () => {} } = {}) {
  const t0 = Date.now();
  const index = loadIndex(root);
  let vectors = embed ? loadVectors(root) : null;
  if (vectors && vectors.model !== embedModel) vectors = { model: embedModel, chunks: {} };
  const files = listFiles(root);
  const seen = new Set();
  let changed = 0, embedded = 0;
  const toEmbed = [];
  for (const f of files) {
    seen.add(f);
    const abs = path.join(root, f);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > MAX_FILE) continue;
    const prev = index.files[f];
    let entry = prev;
    if (!prev || prev.mtime !== st.mtimeMs || prev.size !== st.size) {
      const text = fs.readFileSync(abs, 'utf8');
      if (text.includes('\0')) continue;
      const hash = sha(text);
      if (!prev || prev.hash !== hash) {
        const firstComment = (text.match(/^\s*(?:\/\/|#|\/\*+|\*|<!--)\s*(.{8,120})/m) || [])[1] || '';
        entry = { mtime: st.mtimeMs, size: st.size, hash, lines: text.split('\n').length, symbols: extractSymbols(text, f), summary: firstComment.replace(/\*\/|-->/g, '').trim(), terms: [...new Set(tokenize(text))].slice(0, 400) };
        changed++;
      } else entry = { ...prev, mtime: st.mtimeMs, size: st.size };
      index.files[f] = entry;
    }
    if (vectors) {
      let text = null;
      const chunks = () => chunk(text ??= fs.readFileSync(abs, 'utf8'));
      for (const ch of (vectors.chunks[`${f}#1`]?.hash === entry.hash ? [] : chunks())) {
        toEmbed.push({ key: `${f}#${ch.start}`, hash: entry.hash, text: `${f}\n${ch.text}`.slice(0, 4000), file: f, start: ch.start, end: ch.end });
      }
    }
  }
  let removed = 0;
  for (const f of Object.keys(index.files)) if (!seen.has(f)) { delete index.files[f]; removed++; }
  if (vectors) {
    for (const k of Object.keys(vectors.chunks)) { const f = k.slice(0, k.lastIndexOf('#')); if (!index.files[f] || vectors.chunks[k].hash !== index.files[f].hash) delete vectors.chunks[k]; }
    for (let i = 0; i < toEmbed.length; i += 16) {
      const batch = toEmbed.slice(i, i + 16);
      const vecs = await embed(batch.map((b) => b.text));
      batch.forEach((b, j) => { if (vecs[j]) { vectors.chunks[b.key] = { hash: b.hash, file: b.file, start: b.start, end: b.end, v: encodeVec(vecs[j]) }; embedded++; } });
      onProgress(Math.min(i + 16, toEmbed.length), toEmbed.length);
    }
    index.embedModel = embedModel;
  }
  save(root, index, vectors);
  const symbols = Object.values(index.files).reduce((n, e) => n + e.symbols.length, 0);
  return { files: Object.keys(index.files).length, changed, removed, symbols, embedded, ms: Date.now() - t0 };
}

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

/**
 * Rank files for a query: keyword match on path / symbols / terms (BM25-ish),
 * blended with embedding similarity when vectors exist. Returns [{ file, score, symbols, lines }].
 */
export async function retrieve(root, query, { k = 6, embedQuery = null, index = loadIndex(root) } = {}) {
  const q = [...new Set(tokenize(query))];
  const entries = Object.entries(index.files);
  if (!entries.length || !q.length) return [];
  const df = new Map();
  for (const [, e] of entries) for (const w of new Set(e.terms)) df.set(w, (df.get(w) || 0) + 1);
  const N = entries.length;
  const idf = (w) => Math.log(1 + N / (1 + (df.get(w) || 0)));
  const scores = new Map();
  for (const [f, e] of entries) {
    const pathTerms = new Set(tokenize(f));
    const symTerms = new Set(e.symbols.flatMap((s) => tokenize(s.name)));
    const terms = new Set(e.terms);
    let s = 0;
    for (const w of q) {
      if (pathTerms.has(w)) s += 3 * idf(w);
      if (symTerms.has(w)) s += 2 * idf(w);
      if (terms.has(w)) s += idf(w);
    }
    if (s > 0) scores.set(f, s);
  }
  // Embedding similarity, when available
  if (embedQuery) {
    const vectors = loadVectors(root);
    if (vectors.model && Object.keys(vectors.chunks).length) {
      const qv = await embedQuery(query);
      if (qv) {
        const best = new Map();
        for (const ch of Object.values(vectors.chunks)) {
          const sim = cosine(qv, decodeVec(ch.v));
          if (!best.has(ch.file) || sim > best.get(ch.file).sim) best.set(ch.file, { sim, start: ch.start, end: ch.end });
        }
        const maxKw = Math.max(1, ...scores.values());
        for (const [f, b] of best) if (b.sim > 0.35) scores.set(f, (scores.get(f) || 0) / maxKw + b.sim * 1.2);
      }
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([file, score]) => {
    const e = index.files[file];
    const qs = new Set(q);
    const syms = e.symbols.filter((s) => tokenize(s.name).some((w) => qs.has(w))).concat(e.symbols).slice(0, 5);
    return { file, score: +score.toFixed(3), symbols: [...new Map(syms.map((s) => [s.name, s])).values()], lines: e.lines };
  });
}

/** Compact hint block for the model. */
export function formatHits(hits, maxChars = 700) {
  let out = '';
  for (const h of hits) {
    const line = `- ${h.file} (${h.lines} lines)${h.symbols.length ? ': ' + h.symbols.map((s) => `${s.name}@${s.line}`).join(', ') : ''}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}

/** A short repo map (top-level files with their main symbols) for orientation. */
export function repoMap(index, maxChars = 1200) {
  let out = '';
  for (const [f, e] of Object.entries(index.files).sort((a, b) => a[0].localeCompare(b[0]))) {
    const line = `${f}${e.symbols.length ? ': ' + e.symbols.slice(0, 4).map((s) => s.name).join(', ') : ''}\n`;
    if (out.length + line.length > maxChars) { out += '…\n'; break; }
    out += line;
  }
  return out.trim();
}

/** Wrap an Ollama client as an embedder. nomic-embed-text wants task prefixes for good retrieval. */
export function makeEmbedder(client, model) {
  const nomic = /nomic-embed/.test(model);
  const doc = nomic ? 'search_document: ' : '', qry = nomic ? 'search_query: ' : '';
  return {
    model,
    client,
    embed: (texts) => client.embed(model, texts.map((t) => doc + t)),
    embedQuery: async (q) => (await client.embed(model, [qry + q]))[0]
  };
}
