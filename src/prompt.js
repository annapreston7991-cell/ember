/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import os from 'node:os';

export function toolSignature(def) {
  const f = def.function;
  return `${f.name}{${Object.keys(f.parameters?.properties || {}).join(',')}}`;
}

const EXPLAIN = `EXPLAIN mode: read-only, never edit or run anything.
Explain in plain, friendly language for a non-expert: one short summary paragraph, then at most
5 bullets (how it works, anything risky or broken, with file:line). Under 180 words.`;

export function systemPrompt({ root, tools = [], toolNames, fallback, explain, emberMd, memory }) {
  const names = toolNames || tools.map((t) => t.function.name);
  const parts = [
`You are Ember, a local coding agent in the user's terminal (part of the LLYVerse).
Project: ${root} (${os.platform()}). Today: ${new Date().toISOString().slice(0, 10)}.
Rules:
- Multi-step work: update_plan first; mark a step done only after doing it with a tool.
- Read before editing. Small changes: edit_file. New files: write_file.
- Verify with run_command (tests/build) when possible.
- Stay inside the project. The user approves every change; if they reject one, adapt.
- Follow the project style and the user's preferences below. Lasting preference stated? call remember.
- Be brief. When done, reply with a 1-3 sentence summary and no tool call.`
  ];
  if (fallback) {
    parts.push(
`Tool calling format: to use a tool, reply with ONLY one JSON object on its own, like
{"tool": "read_file", "arguments": {"path": "package.json"}}
Available tools and their arguments: ${tools.length ? tools.map(toolSignature).join(' ') : names.join(', ')}.
update_plan takes steps:[{step,status}].
You will receive the tool result in the next message. When you are finished, reply in plain text with no JSON.`);
  }
  if (explain) parts.push(EXPLAIN);
  if (emberMd) parts.push(`Project instructions from EMBER.md (follow these):\n${emberMd.slice(0, 6000)}`);
  if (memory) parts.push(`What you have learned about this user and project (local memory):\n${memory}`);
  return parts.join('\n\n');
}

export const DISTILL_PROMPT = `You maintain a short memory of a developer's lasting preferences for a coding assistant.
From the session log below, extract at most 5 DURABLE notes worth remembering next time
(languages, frameworks, code style, testing habits, how much explanation they want, tone,
what they tend to approve or reject, how they edited your code afterwards).
Skip one-off task details (specific function names, files or features from this task are NOT preferences). Skip anything already in the existing notes unless it changed.
Each note: one short imperative sentence, e.g. "Use 2-space indentation" or "Prefers short answers".
Reply with ONLY JSON: {"notes":[{"text":"...","scope":"global"|"project"}]}. Use {"notes":[]} if nothing is durable.`;

export const CONSOLIDATE_PROMPT = `Merge this list of memory notes about a developer into a shorter list.
Combine duplicates, drop stale or trivial ones, and when two notes conflict keep the NEWER one (later ts).
Keep each note one short sentence. Reply with ONLY JSON: {"notes":[{"text":"...","ts":"<newest ts of the merged notes>"}]}.`;

export const COMMIT_PROMPT = `Write a git commit message for the diff below.
Format: a summary line in the imperative mood ("Add …", "Fix …", "Update …"), at most 72 characters,
describing what THIS diff actually changes (name the real files/functions),
then a blank line and 1-5 short "- " bullet points if the change is not trivial.
Reply with ONLY the commit message, no quotes, no code fences.`;

export const NEW_PROJECT_PROMPT = (idea, dir) => `Create a complete, working new project in the current directory (${dir}) for this idea:

"${idea}"

Steps:
1. Call update_plan with a short plan (pick a simple, popular stack; prefer Node.js unless the idea clearly needs something else).
2. Write every file with write_file: a package.json (or equivalent) with "start" and "test" scripts, the source code, at least one test, a README.md with how to run it, and a .gitignore.
3. Install dependencies with run_command (e.g. npm install). Keep dependencies few.
4. Run the tests with run_command and fix anything that fails.
5. Finish with a short summary: what you built, how to start it, and what to try next.`;
