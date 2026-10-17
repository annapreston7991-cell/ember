/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/**
 * Apply a search/replace edit. The search text must match exactly once
 * (unless replaceAll). Falls back to CRLF-normalized and trailing-whitespace-
 * tolerant matching so small model formatting slips still work.
 */
export function applyEdit(content, search, replace, { replaceAll = false } = {}) {
  if (typeof search !== 'string' || search === '') throw new Error('edit_file: "search" must be a non-empty string');
  if (typeof replace !== 'string') throw new Error('edit_file: "replace" must be a string');

  const tryExact = (hay, s, r) => {
    const n = countOccurrences(hay, s);
    if (n === 0) return null;
    if (n > 1 && !replaceAll) throw new Error(`edit_file: search text matches ${n} times; add more surrounding context or set replace_all`);
    return replaceAll ? hay.split(s).join(r) : hay.replace(s, () => r);
  };

  let out = tryExact(content, search, replace);
  if (out !== null) return out;

  const crlf = content.includes('\r\n');
  if (crlf) {
    out = tryExact(content, search.replace(/\r?\n/g, '\r\n'), replace.replace(/\r?\n/g, '\r\n'));
    if (out !== null) return out;
  }

  // Line-based match ignoring trailing whitespace on each line.
  const eol = crlf ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const sLines = search.replace(/\r?\n$/, '').split(/\r?\n/).map((l) => l.trimEnd());
  const hits = [];
  for (let i = 0; i + sLines.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < sLines.length; k++) if (lines[i + k].trimEnd() !== sLines[k]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  if (hits.length === 0) throw new Error('edit_file: search text not found in file. Read the file again and copy the exact lines.');
  if (hits.length > 1 && !replaceAll) throw new Error(`edit_file: search text matches ${hits.length} times; add more context`);
  const rLines = replace.replace(/\r?\n$/, '').split(/\r?\n/);
  for (const i of hits.reverse()) lines.splice(i, sLines.length, ...rLines);
  return lines.join(eol);
}
