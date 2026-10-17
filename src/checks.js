/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Detect how to verify a project (tests, build, lint) for the self-fix loop and watch mode.
import fs from 'node:fs';
import path from 'node:path';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

export function packageManager(root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/** Returns [{ name, command }] in the order they should run (cheap first). */
export function detectChecks(root, cfg = {}) {
  if (Array.isArray(cfg.checks?.commands) && cfg.checks.commands.length) {
    return cfg.checks.commands.map((c) => ({ name: c, command: c }));
  }
  const out = [];
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg?.scripts) {
    const pm = packageManager(root);
    const run = (s) => (s === 'test' ? `${pm} test` : `${pm} run ${s}`);
    for (const s of ['typecheck', 'lint', 'build', 'test']) {
      const v = pkg.scripts[s];
      if (!v || /no test specified/.test(v) || /--watch|\bwatch\b/.test(v)) continue;
      out.push({ name: s, command: run(s) });
    }
  }
  const has = (f) => fs.existsSync(path.join(root, f));
  if (!out.length && (has('pyproject.toml') || has('pytest.ini') || has('tests'))) {
    if (has('pyproject.toml') || has('pytest.ini') || has('setup.py')) out.push({ name: 'test', command: 'python3 -m pytest -q' });
  }
  if (!out.length && has('go.mod')) out.push({ name: 'test', command: 'go test ./...' });
  if (!out.length && has('Cargo.toml')) out.push({ name: 'test', command: 'cargo test' });
  return out;
}

export function failed(result) {
  const m = String(result).match(/^exit code (\S+)/);
  return !m || m[1] !== '0';
}
