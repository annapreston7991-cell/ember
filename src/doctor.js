/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { OllamaClient, ollamaBinary } from './ollama.js';
import { loadConfig, configPath } from './config.js';
import { detectHardware, pickModel } from './hardware.js';
import { profilePath, projectMemoryPath } from './memory.js';
import { c } from './ui.js';

export async function runDoctor({ ui, root }) {
  const cfg = loadConfig();
  let problems = 0;
  const bad = (s) => { problems++; ui.error(s); };
  ui.print(c.bold().yellow('Ember doctor'));

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ui.ok(`Node.js ${process.versions.node}`); else bad(`Node.js ${process.versions.node} is too old (need 18+)`);

  if (cfg._exists) ui.ok(`Config: ${configPath()}`); else bad(`No config yet at ${configPath()}. Run: ember setup`);

  const bin = ollamaBinary();
  if (bin) ui.ok(`Ollama binary: ${bin}`); else bad('Ollama is not installed. Run: ember setup');

  const client = new OllamaClient(cfg.host);
  const v = await client.version();
  if (v) ui.ok(`Ollama server ${v} at ${cfg.host}`); else bad(`Ollama server not reachable at ${cfg.host}. Run: ollama serve`);

  if (v) {
    try {
      if (await client.hasModel(cfg.model)) {
        ui.ok(`Model ${cfg.model} is installed`);
        const t = await client.supportsTools(cfg.model);
        ui.ok(`Tool calling: ${t === false ? 'JSON fallback mode' : t ? 'native' : 'unknown (will try native, then fall back)'}`);
      } else bad(`Model ${cfg.model} is not downloaded. Run: ember setup  (or: ollama pull ${cfg.model})`);
    } catch (e) { bad(`Could not list models: ${e.message}`); }
  }

  const hw = detectHardware();
  ui.ok(`Hardware: ${hw.ramGB} GB RAM${hw.gpu ? `, ${hw.gpu}` : ''} → recommended ${pickModel(hw)}`);
  const rg = spawnSync('rg', ['--version']);
  ui.print((rg.status === 0 ? c.green('✓ ') : c.gray('· ')) + `ripgrep ${rg.status === 0 ? 'found (fast search)' : 'not found (using built-in search)'}`);

  const mem = cfg.memory?.enabled !== false;
  ui.print(c.green('✓ ') + `Memory: ${mem ? 'on' : 'off'}${mem ? ` · profile ${fs.existsSync(profilePath()) ? profilePath() : '(empty)'}` : ''}`);
  if (mem && root && fs.existsSync(projectMemoryPath(root))) ui.print(c.green('✓ ') + `Project memory: ${projectMemoryPath(root)}`);
  ui.print(c.green('✓ ') + `Allowlisted commands: ${cfg.allowlist.length}`);

  ui.print('');
  if (problems) ui.print(c.yellow(`${problems} problem(s) found.`)); else ui.print(c.green('All good. Ember is ready.'));
  return problems === 0;
}
