/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Small models often answer "create hello.py" by pasting the code into the chat instead of
// calling write_file. This finds those code blocks and the file each one is meant for, so Ember
// can offer "Save to hello.py?" (the user still approves, with a diff).

const EXT = 'py|js|mjs|cjs|ts|tsx|jsx|html?|css|scss|sass|less|json|md|sh|bash|zsh|txt|ya?ml|toml|ini|cfg|conf|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|sql|vue|svelte|xml|svg|lua|pl|r|swift|dart|env|gitignore|dockerignore|csv';
const FILE_RE = new RegExp(`(?:^|[\\s\`*"'(\\[:])((?:\\.{0,2}/)?(?:[\\w@.+-]+/)*(?:[\\w@+-][\\w@.+-]*\\.(?:${EXT})|Dockerfile|Makefile|Procfile|\\.gitignore|\\.env))(?=$|[\\s\`*"'),:;!?\\]]|\\.(?:\\s|$))`, 'gi');
const SHELL_LANGS = /^(bash|sh|shell|console|zsh|terminal|cmd|powershell|ps1|text|plaintext|output)?$/i;
const LANG_EXT = { python: 'py', py: 'py', javascript: 'js', js: 'js', node: 'js', typescript: 'ts', ts: 'ts', html: 'html', css: 'css', json: 'json', bash: 'sh', sh: 'sh', shell: 'sh', go: 'go', rust: 'rs', java: 'java', ruby: 'rb', php: 'php', yaml: 'yml', yml: 'yml', markdown: 'md', md: 'md', sql: 'sql', c: 'c', cpp: 'cpp', jsx: 'jsx', tsx: 'tsx', toml: 'toml' };

export function fileNamesIn(text) {
  const out = [];
  let m;
  FILE_RE.lastIndex = 0;
  while ((m = FILE_RE.exec(String(text || '')))) out.push(m[1].replace(/^\.\//, ''));
  return out;
}

/** Fenced code blocks: [{ info, lang, code, start, end }]. */
export function codeBlocks(text) {
  const out = [];
  const re = /(^|\n)[ \t]*(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const info = m[3].trim();
    out.push({ info, lang: (info.split(/\s+/)[0] || '').toLowerCase(), code: m[4], start: m.index + m[1].length, end: m.index + m[0].length });
  }
  return out;
}

function looksLikeCommands(code) {
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return true;
  const cmd = /^(\$ |> |sudo |npm |npx |pnpm |yarn |node |python3? |pip3? |cd |ls|mkdir |chmod |git |curl |wget |bash |sh |\.\/|go run|cargo |ember |ollama |deno |bun |source |export )/;
  return lines.length <= 4 && lines.every((l) => cmd.test(l) || l.startsWith('#'));
}

function isToolJson(code) { return /^\s*[[{][\s\S]*"(name|tool|tool_calls|function)"\s*:/.test(code); }

/**
 * Code blocks in a reply that are meant to be saved as files.
 * Returns [{ path, content, reason }] (deduplicated by path, last block wins).
 */
export function extractCodeFiles(reply, userText = '') {
  const text = String(reply || '');
  const blocks = codeBlocks(text).filter((b) => b.code.trim() && !isToolJson(b.code));
  const asked = [...new Set(fileNamesIn(userText))];
  const found = new Map();
  let prevEnd = 0;
  const unnamed = [];
  for (const b of blocks) {
    let name = null, reason = null;
    // 1. ```python hello.py   or   ```hello.py   or   ```js title="server.js"
    const inInfo = fileNamesIn(` ${b.info.replace(/(title|file(name)?)=/gi, ' ')} `);
    if (inInfo.length) { name = inInfo[0]; reason = 'fence'; }
    // 2. First line comment: "# hello.py", "// file: server.js", "<!-- index.html -->"
    if (!name) {
      const first = b.code.split('\n')[0];
      const cm = /^\s*(?:#|\/\/|<!--|\/\*|--|;)\s*(?:file(?:name)?\s*[:=]\s*)?(\S+)\s*(?:-->|\*\/)?\s*$/i.exec(first);
      if (cm && fileNamesIn(` ${cm[1]} `).length) { name = fileNamesIn(` ${cm[1]} `)[0]; reason = 'comment'; }
    }
    // 3. The closest preceding line that names a file ("Create `hello.py`:", "**server.js**")
    if (!name) {
      const before = text.slice(prevEnd, b.start).split('\n').map((l) => l.trim()).filter(Boolean);
      for (let k = before.length - 1; k >= Math.max(0, before.length - 2) && !name; k--) {
        const names = fileNamesIn(before[k]).filter((n) => !/^(python3?|node)$/i.test(n));
        if (names.length) { name = names[names.length - 1]; reason = 'text'; }
      }
    }
    prevEnd = b.end;
    if (!name) {
      if (!(SHELL_LANGS.test(b.lang) && looksLikeCommands(b.code))) unnamed.push(b);
      continue;
    }
    const isShellFile = /\.(sh|bash|zsh)$/i.test(name);
    if (!isShellFile && SHELL_LANGS.test(b.lang) && b.lang && looksLikeCommands(b.code)) continue;
    found.set(name, { path: name, content: b.code.endsWith('\n') ? b.code : b.code + '\n', reason });
  }
  // 4. The user named exactly one file and the reply has exactly one real code block.
  if (!found.size && asked.length === 1 && unnamed.length === 1) {
    const b = unnamed[0];
    const ext = asked[0].split('.').pop().toLowerCase();
    const langExt = LANG_EXT[b.lang];
    if (!langExt || langExt === ext || (ext === 'htm' && langExt === 'html')) {
      found.set(asked[0], { path: asked[0], content: b.code.endsWith('\n') ? b.code : b.code + '\n', reason: 'request' });
    }
  }
  return [...found.values()];
}

/** Whether a request asks Ember to produce or change files (not just explain). */
export function wantsFiles(userText) {
  const t = String(userText || '').trim();
  if (/^(what|why|how|where|which|who|when|explain|describe|show me how)\b/i.test(t) && !/\b(create|write|make|save|add)\b/i.test(t)) return false;
  return /\b(create|write|make|add|build|generate|save|put|implement|scaffold|set ?up|fix|update|change|modify|refactor|rewrite|need|want|code)\b/i.test(t) || fileNamesIn(t).length > 0;
}

/** Code blocks without a file name (for a nudge to save them properly). */
export function hasUnsavedCode(reply) {
  return codeBlocks(String(reply || '')).some((b) => b.code.trim().split('\n').length >= 2 && !isToolJson(b.code) && !(SHELL_LANGS.test(b.lang) && looksLikeCommands(b.code)));
}
