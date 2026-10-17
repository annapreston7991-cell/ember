/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */

/** Find top-level balanced {...} JSON objects in free text (string/escape aware). */
export function findJsonObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    const raw = text.slice(i, j + 1);
    try {
      out.push({ value: JSON.parse(raw), start: i, end: j + 1 });
      i = j;
    } catch { /* not JSON, keep scanning inside */ }
  }
  return out;
}

function normalizeCall(obj, toolNames) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.function && typeof obj.function === 'object') obj = obj.function;
  const name = obj.name ?? obj.tool ?? obj.tool_name ?? obj.function;
  let args = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input ?? {};
  if (typeof name !== 'string') return null;
  if (toolNames && !toolNames.includes(name)) return null;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (typeof args !== 'object' || args === null) args = {};
  return { name, arguments: args };
}

/**
 * Fallback parser for models without native tool calling.
 * Accepts <tool_call>{...}</tool_call>, ```json fenced blocks, or bare JSON objects
 * shaped like {"tool"|"name": "...", "arguments"|"args": {...}}. Arrays are accepted too.
 * Returns { calls, text } where text is the content with tool-call JSON removed.
 */
export function parseToolCalls(content, toolNames) {
  if (!content) return { calls: [], text: '' };
  const calls = [];
  let text = content;
  const spans = [];

  const tagRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m;
  while ((m = tagRe.exec(content))) {
    for (const o of findJsonObjects(m[1])) {
      const c = normalizeCall(o.value, toolNames);
      if (c) calls.push(c);
    }
    spans.push([m.index, m.index + m[0].length]);
  }

  if (!calls.length) {
    // Arrays of calls: [{"tool":..},{"tool":..}]
    for (const o of findJsonObjects(content)) {
      const c = normalizeCall(o.value, toolNames);
      if (c) { calls.push(c); spans.push([o.start, o.end]); }
      else if (Array.isArray(o.value?.tool_calls)) {
        for (const tc of o.value.tool_calls) { const n = normalizeCall(tc, toolNames); if (n) calls.push(n); }
        spans.push([o.start, o.end]);
      }
    }
  }

  spans.sort((a, b) => b[0] - a[0]);
  for (const [s, e] of spans) text = text.slice(0, s) + text.slice(e);
  text = text.replace(/```(?:json)?\s*```/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { calls, text };
}
