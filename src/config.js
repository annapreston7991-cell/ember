/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function emberHome() {
  return process.env.EMBER_HOME || path.join(os.homedir(), '.ember');
}

export function configPath() {
  return path.join(emberHome(), 'config.json');
}

export const DEFAULT_ALLOWLIST = [
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'tree', 'which', 'file', 'stat', 'du', 'df',
  'git status', 'git diff', 'git log', 'git show', 'git branch',
  'rg', 'grep',
  'node --version', 'npm --version', 'npm ls', 'npm view', 'python3 --version'
];

export const DEFAULTS = {
  model: 'qwen2.5-coder:7b',
  host: 'http://127.0.0.1:11434',
  numCtx: 8192,
  keepAlive: '30m',      // how long Ollama keeps models loaded between requests
  fastModel: null,       // small model for quick jobs (commit messages, explain, memory); set by setup
  router: { explain: 'fast', commit: 'fast', memory: 'fast', plan: 'main' },
  steps: { enabled: true, maxSteps: 6 }, // split big jobs into small focused steps
  temperature: 0.2,
  maxSteps: 25,
  allowlist: DEFAULT_ALLOWLIST,
  memory: {
    enabled: true,      // set false to turn off all memory and learning
    autoLearn: true,    // distill notes at the end of each session
    maxPromptChars: 1800, // cap on memory injected into each prompt
    maxNotes: 60        // per scope; older learned notes are merged/dropped
  },
  approvals: {
    suggestAfter: 3     // suggest allowlisting a command after N approvals in a row
  },
  git: { checkpoints: true },              // snapshot to refs/ember/* before each task
  selfFix: { enabled: true, maxAttempts: 3, timeoutSec: 300 },
  checks: { commands: [] },                // override detected test/build/lint commands
  visionModel: 'qwen2.5vl:3b',             // used for /image and screenshots in prompts
  web: { enabled: false },                 // web_search / web_fetch tools (off by default)
  cloud: { defaultProvider: 'grok' },      // used by "cloud:<model>"
  providers: {},                           // extra OpenAI-compatible endpoints
  plugins: { enabled: true },
  index: { enabled: true, embeddings: true, embedModel: 'nomic-embed-text', autoMaxFiles: 3000, hints: 6 },
  watch: { debounceMs: 600, intervalMs: 1000 },
  pro: { enabled: false }                  // hook for a future Pro tier; nothing is gated today
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch { /* first run */ }
  const cfg = deepMerge(DEFAULTS, saved);
  if (process.env.OLLAMA_HOST && !saved.host) {
    const h = process.env.OLLAMA_HOST;
    cfg.host = h.startsWith('http') ? h : `http://${h}`;
  }
  cfg._exists = fs.existsSync(configPath());
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(emberHome(), { recursive: true });
  const { _exists, ...clean } = cfg;
  // 0600: the config may hold API keys for optional cloud providers.
  fs.writeFileSync(configPath(), JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(configPath(), 0o600); } catch { /* windows */ }
}
