/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Fast/smart routing: quick jobs go to a small model, coding goes to the main model,
// and big requests are split into small focused steps.

// Count actions only where a clause starts ("Create x, add y, then run z"), not inside names like add.test.js.
const ACTIONS = /(?:^|[,;]\s*|[.:]\s+|\n\s*|\b(?:then|and|also|finally)\s+)(create|add|write|build|implement|make|fix|update|refactor|rename|move|delete|remove|run|test|install|set up|setup|configure|deploy|migrate|convert|generate)\b/gi;

/** Cheap, local classification (no model call): is this a multi-part job? */
export function classifyTask(text) {
  const t = String(text || '');
  const actions = (t.match(ACTIONS) || []).length;
  const numbered = (t.match(/(^|\n)\s*(\d+[.)]|[-*])\s+\S/g) || []).length;
  const words = t.split(/\s+/).filter(Boolean).length;
  const question = /^(what|why|how|where|which|who|when|is|are|does|do|can|could|should)\b/i.test(t.trim()) && actions <= 1;
  if (question) return 'question';
  // Splitting costs extra model calls, so only do it for genuinely big jobs (measured: it slows
  // down 3-step tasks on a 7B model, but keeps long jobs focused and contexts short).
  if (numbered >= 3 || actions >= 4 || words > 90 || /\b(build|create|make)\b.*\b(app|project|website|api|game|dashboard)\b.*\b(with|that|including)\b/i.test(t)) return 'big';
  return 'small';
}

/** Parse the planner's reply into [{ task, files[] }]. Accepts strings, {step}, {task, files} or a numbered list. */
export function parseTasks(text, max = 6) {
  const raw = String(text || '');
  let tasks = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const arr = Array.isArray(j.steps) ? j.steps : Array.isArray(j.tasks) ? j.tasks : null;
      if (arr) {
        tasks = arr.map((s) => typeof s === 'string' ? { task: s.trim(), files: [] } : {
          task: String(s?.task || s?.step || '').trim(),
          files: Array.isArray(s?.files) ? s.files.map(String) : []
        });
      }
    } catch { /* maybe truncated: recover the complete task objects below */ }
  }
  if (!tasks) {
    const re = /\{\s*"(?:task|step)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"files"\s*:\s*\[([^\]]*)\])?\s*\}/g;
    const found = [...raw.matchAll(re)].map((x) => ({ task: JSON.parse(`"${x[1]}"`), files: [...(x[2] || '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((f) => f[1]) }));
    if (found.length) tasks = found;
  }
  if (!tasks) {
    tasks = raw.split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s+/, '').trim())
      .filter((l) => l.length > 3 && !/^[{}[\]`]/.test(l) && !/^"?\w+"?\s*:/.test(l) && !/"\s*:\s*["[]/.test(l))
      .map((task) => ({ task, files: [] }));
  }
  // Normalize, then merge neighbours that work on exactly the same files (one helper per file set).
  const out = [];
  for (const t of tasks) {
    const files = [...new Set(t.files.map((f) => f.trim().replace(/^\.\//, '')).filter(Boolean))].slice(0, 8);
    if (!t.task) continue;
    const prev = out.at(-1);
    if (prev && files.length && prev.files.length === files.length && files.every((f) => prev.files.includes(f))) prev.task += `; ${t.task.replace(/\.$/, '')}`;
    else out.push({ task: t.task, files });
  }
  return out.slice(0, max);
}

export function parseSteps(text, max = 6) { return parseTasks(text, max).map((t) => t.task); }

export const PLAN_PROMPT = `Split the developer's request into 2-6 small, concrete, independently checkable steps.
Each step: one short imperative sentence, plus the files it will create or change. Do not add steps that were not asked for.
Reply with ONLY JSON: {"steps":[{"task":"...","files":["path/one.js"]},{"task":"...","files":["path/two.js"]}]}`;
