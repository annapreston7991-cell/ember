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

export function parseSteps(text, max = 6) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (Array.isArray(j.steps)) return j.steps.map((s) => String(typeof s === 'string' ? s : s?.step || '').trim()).filter(Boolean).slice(0, max);
    } catch { /* fall through */ }
  }
  return String(text || '').split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s+/, '').trim()).filter((l) => l.length > 3 && !/^[{}[\]]/.test(l)).slice(0, max);
}

export const PLAN_PROMPT = `Split the developer's request into 2-6 small, concrete, independently checkable steps.
Each step: one short imperative sentence naming the file(s) involved. Do not add steps that were not asked for.
Reply with ONLY JSON: {"steps":["...","..."]}`;
