/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */

/**
 * JSON.parse, then a lenient retry for what small models really emit: raw newlines/tabs inside
 * strings, trailing commas, \' escapes, and Python-style True/False/None.
 */
export function parseLenient(raw) {
  try { return JSON.parse(raw); } catch { /* repair below */ }
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) { esc = false; out += ch === "'" ? "'" : (/["\\/bfnrtu]/.test(ch) ? '\\' + ch : '\\\\' + ch); continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch < ' ') { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
      out += ch;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    out += ch;
  }
  out = out.replace(/,\s*([}\]])/g, '$1').replace(/:\s*True\b/g, ': true').replace(/:\s*False\b/g, ': false').replace(/:\s*None\b/g, ': null');
  return JSON.parse(out);
}

/** Find top-level balanced {...} JSON objects in free text (string/escape aware, lenient). */
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
    if (depth !== 0) {
      // Small models sometimes stop before the last "}" (or mid-string). Only at the very end of
      // the reply: close what is open and try once.
      if (depth > 0 && j >= text.length && /^\{\s*"/.test(text.slice(i))) {
        const body = text.slice(i).replace(/\s*(```\s*)?$/, '');
        const tries = [];
        // Unclosed string followed by the closing braces the model meant: ..."content": "x\n  }\n}
        const closers = inStr ? /(\s*\})+\s*$/.exec(body) : null;
        if (closers) tries.push(body.slice(0, closers.index) + '"' + '}'.repeat(depth));
        tries.push(body + (inStr ? '"' : '') + '}'.repeat(depth));
        for (const t of tries) {
          try { out.push({ value: parseLenient(t), start: i, end: text.length, repaired: true }); break; } catch { /* next */ }
        }
        if (out.length && out[out.length - 1].repaired) break;
      }
      continue;
    }
    const raw = text.slice(i, j + 1);
    try {
      out.push({ value: parseLenient(raw), start: i, end: j + 1 });
      i = j;
    } catch { /* not JSON, keep scanning inside */ }
  }
  return out;
}

const ARG_KEYS = ['arguments', 'args', 'parameters', 'params', 'input'];

function normalizeCall(obj, toolNames) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.function && typeof obj.function === 'object') obj = { ...obj.function, ...(obj.function.arguments ? {} : { arguments: obj.arguments }) };
  const name = obj.name ?? obj.tool ?? obj.tool_name ?? obj.function ?? obj.action;
  if (typeof name !== 'string') return null;
  if (toolNames && !toolNames.includes(name)) return null;
  const key = ARG_KEYS.find((k) => obj[k] !== undefined);
  let args;
  if (key) args = obj[key];
  else {
    // Flat style: {"tool": "write_file", "path": "a.py", "content": "..."}
    args = {};
    for (const [k, v] of Object.entries(obj)) if (!['name', 'tool', 'tool_name', 'function', 'action', 'id', 'type'].includes(k)) args[k] = v;
  }
  if (typeof args === 'string') {
    try { args = parseLenient(args); } catch { args = {}; }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) args = {};
  return { name, arguments: args };
}

// ---------- function-call style: write_file(path="a.py", content="""...""") ----------

function readPyString(s, i) {
  const q3 = s.slice(i, i + 3);
  if (q3 === '"""' || q3 === "'''") {
    const end = s.indexOf(q3, i + 3);
    if (end === -1) return null;
    return { value: s.slice(i + 3, end).replace(/^\n/, ''), next: end + 3 };
  }
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let v = '';
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\' && q !== '`') {
      const n = s[j + 1];
      v += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
      j++;
      continue;
    }
    if (ch === q) return { value: v, next: j + 1 };
    v += ch;
  }
  return null;
}

function parseCallArgs(s, i) {
  // s[i] is just after "(" ; returns { pos: [], kw: {}, end }
  const pos = [], kw = {};
  let j = i;
  const ws = () => { while (j < s.length && /\s/.test(s[j])) j++; };
  for (;;) {
    ws();
    if (s[j] === ')') return { pos, kw, end: j + 1 };
    let key = null;
    const km = /^([A-Za-z_]\w*)\s*[=:]\s*/.exec(s.slice(j, j + 64));
    if (km && !/^(true|false|null|None|True|False)\b/.test(km[1])) { key = km[1]; j += km[0].length; }
    ws();
    let val;
    const str = readPyString(s, j);
    if (str) { val = str.value; j = str.next; }
    else if (s[j] === '{' || s[j] === '[') {
      const objs = s[j] === '{' ? findJsonObjects(s.slice(j)) : [];
      if (!objs.length || objs[0].start !== 0) return null;
      val = objs[0].value; j += objs[0].end;
    } else {
      const m = /^(-?\d+(?:\.\d+)?|true|false|True|False|null|None)/.exec(s.slice(j));
      if (!m) return null;
      val = /^-?\d/.test(m[1]) ? Number(m[1]) : /^(true|True)$/.test(m[1]) ? true : /^(false|False)$/.test(m[1]) ? false : null;
      j += m[1].length;
    }
    if (key) kw[key] = val; else pos.push(val);
    ws();
    if (s[j] === ',') { j++; continue; }
    if (s[j] === ')') return { pos, kw, end: j + 1 };
    return null;
  }
}

/** Calls written like code: write_file(path="x", content="""..."""), or write_file("x", "..."). */
export function parseFunctionStyle(content, toolDefs) {
  const calls = [], spans = [];
  for (const def of toolDefs) {
    const name = def.function.name;
    const order = Object.keys(def.function.parameters?.properties || {});
    const re = new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(content))) {
      const r = parseCallArgs(content, m.index + m[0].length);
      if (!r) continue;
      const args = { ...r.kw };
      r.pos.forEach((v, k) => { if (order[k] && args[order[k]] === undefined) args[order[k]] = v; });
      const required = def.function.parameters?.required || [];
      if (!required.every((k) => args[k] !== undefined)) continue;
      calls.push({ name, arguments: args, at: m.index });
      spans.push([m.index, r.end]);
      re.lastIndex = r.end;
    }
  }
  calls.sort((a, b) => a.at - b.at);
  return { calls: calls.map(({ at, ...c }) => c), spans };
}

/**
 * Fallback parser for tool calls written into the reply text (models without native tool
 * calling, and small models that ignore it). Accepts:
 *   <tool_call>{...}</tool_call>, <function=name>{...}</function>, <|tool_call|>{...}, [TOOL_CALLS] [...]
 *   ```json fenced or bare JSON: {"name"|"tool": ..., "arguments"|"args"|"parameters": {...}} (or flat args),
 *   {"tool_calls": [...]}, arrays of calls, lenient JSON (raw newlines in strings, trailing commas),
 *   and function-call style write_file(path="a.py", content="""...""") when toolDefs are given.
 * Returns { calls, text, style } where text is the content with the tool calls removed.
 */
export function parseToolCalls(content, toolNames, toolDefs = null) {
  if (!content) return { calls: [], text: '', style: null };
  const calls = [];
  let text = content;
  const spans = [];
  let style = null;

  const tagRe = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)|<function=([\w-]+)>([\s\S]*?)(?:<\/function>|$)/g;
  let m;
  while ((m = tagRe.exec(content))) {
    if (!m[0]) { tagRe.lastIndex++; continue; }
    if (m[2]) {
      const objs = findJsonObjects(m[3]);
      const c = normalizeCall({ name: m[2], arguments: objs[0]?.value || {} }, toolNames);
      if (c) calls.push(c);
    } else {
      for (const o of findJsonObjects(m[1])) {
        const c = normalizeCall(o.value, toolNames);
        if (c) calls.push(c);
      }
    }
    spans.push([m.index, m.index + m[0].length]);
  }
  if (calls.length) style = 'tag';

  if (!calls.length) {
    for (const o of findJsonObjects(content)) {
      const c = normalizeCall(o.value, toolNames);
      if (c) { calls.push(c); spans.push([o.start, o.end]); }
      else if (Array.isArray(o.value?.tool_calls)) {
        for (const tc of o.value.tool_calls) { const n = normalizeCall(tc, toolNames); if (n) calls.push(n); }
        spans.push([o.start, o.end]);
      }
    }
    // Top-level arrays: [{"name":...}, {"name":...}]
    if (!calls.length) {
      const am = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (am) {
        try {
          const arr = parseLenient(am[0]);
          for (const x of Array.isArray(arr) ? arr : []) { const n = normalizeCall(x, toolNames); if (n) calls.push(n); }
          if (calls.length) spans.push([am.index, am.index + am[0].length]);
        } catch { /* not an array of calls */ }
      }
    }
    if (calls.length) style = 'json';
  }

  if (!calls.length && toolDefs) {
    const defs = toolDefs.filter((d) => !toolNames || toolNames.includes(d.function.name));
    const f = parseFunctionStyle(content, defs);
    if (f.calls.length) { calls.push(...f.calls); spans.push(...f.spans); style = 'function'; }
  }

  spans.sort((a, b) => b[0] - a[0]);
  for (const [s, e] of spans) text = text.slice(0, s) + text.slice(e);
  text = text.replace(/```[\w-]*\s*```/g, '').replace(/<\|?tool_call\|?>|\[TOOL_CALLS\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { calls, text, style };
}
