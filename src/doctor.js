/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OllamaClient, ollamaBinary } from './ollama.js';
import { loadConfig, configPath } from './config.js';
import { detectHardware, pickModel } from './hardware.js';
import { profilePath, projectMemoryPath } from './memory.js';
import { c } from './ui.js';
import { BUILTIN_PROVIDERS, configPermsOk } from './cloud.js';

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

  if (cfg.fastModel && v) { try { ui.print(((await client.hasModel(cfg.fastModel)) ? c.green('✓ ') + `Fast helper model ${cfg.fastModel} (commit messages, explain, memory)` : c.yellow('! ') + `Fast helper model ${cfg.fastModel} missing (ollama pull ${cfg.fastModel})`)); } catch { /* ignore */ } }
  ui.print(c.green('✓ ') + `keep_alive ${cfg.keepAlive} · num_ctx ${cfg.numCtx}`);
  const vm = cfg.visionModel || 'qwen2.5vl:3b';
  if (v) { try { ui.print(((await client.hasModel(vm)) ? c.green('✓ ') + `Vision model ${vm} installed` : c.gray('· ') + `Vision model ${vm} not installed (optional: ember setup --vision)`)); } catch { /* ignore */ } }
  ui.print(c.green('✓ ') + `Self-fix loop: ${cfg.selfFix?.enabled !== false ? `on (up to ${cfg.selfFix?.maxAttempts ?? 3} attempts)` : 'off'} · git checkpoints: ${cfg.git?.checkpoints !== false ? 'on' : 'off'} · web lookup: ${cfg.web?.enabled ? 'on' : 'off'}`);
  for (const [name, p] of Object.entries({ ...BUILTIN_PROVIDERS, ...(cfg.providers || {}) })) {
    const has = (p.apiKeyEnv && process.env[p.apiKeyEnv]) || p.apiKey;
    if (has) ui.print(c.green('✓ ') + `Cloud provider ${name} has a key (use --model cloud:${name}:<model>)`);
  }
  if (!configPermsOk()) bad(`${configPath()} is readable by other users. Run: chmod 600 ${configPath()}`);
  const hw = detectHardware();
  ui.ok(`Hardware: ${hw.ramGB} GB RAM${hw.gpu ? `, ${hw.gpu}` : ''} → recommended ${pickModel(hw)}`);
  const rg = spawnSync('rg', ['--version']);
  ui.print((rg.status === 0 ? c.green('✓ ') : c.gray('· ')) + `ripgrep ${rg.status === 0 ? 'found (fast search)' : 'not found (using built-in search)'}`);

  const mem = cfg.memory?.enabled !== false;
  ui.print(c.green('✓ ') + `Memory: ${mem ? 'on' : 'off'}${mem ? ` · profile ${fs.existsSync(profilePath()) ? profilePath() : '(empty)'}` : ''}`);
  if (mem && root && fs.existsSync(projectMemoryPath(root))) ui.print(c.green('✓ ') + `Project memory: ${projectMemoryPath(root)}`);
  ui.print(c.green('✓ ') + `Allowlisted commands: ${cfg.allowlist.length}`);
  {
    const { voiceStatus } = await import('./voice.js');
    const vs = voiceStatus(cfg);
    ui.print((vs.stt ? c.green('✓ ') : c.gray('· ')) + `Voice (optional): mic ${vs.rec || 'none'} · speech-to-text ${vs.stt || 'not installed (ember voice offers faster-whisper)'} · speech ${vs.tts || 'none'}`);
  }
  {
    const { proStatus } = await import('./pro.js');
    const ps = proStatus(cfg);
    ui.print((ps.pro ? c.green('✓ ') : c.gray('· ')) + `Ember Pro: ${ps.pro ? `active until ${ps.expires}` : `not active${ps.from ? ` (${ps.reason})` : ''} — every local feature is free`}`);
  }
  if (cfg.index?.enabled !== false) {
    const ip = root && path.join(root, '.ember', 'index', 'index.json');
    let n = 0; try { n = Object.keys(JSON.parse(fs.readFileSync(ip, 'utf8')).files || {}).length; } catch { /* none yet */ }
    let emb = false; try { emb = v ? await client.hasModel(cfg.index?.embedModel || 'nomic-embed-text') : false; } catch { /* offline */ }
    ui.print((n ? c.green('✓ ') : c.gray('· ')) + `Project index: ${n ? `${n} files` : 'not built yet (ember index)'} · embeddings ${emb ? `on (${cfg.index?.embedModel || 'nomic-embed-text'})` : 'off (keywords + symbols)'}`);
  } else ui.print(c.gray('· Project index: off'));

  ui.print('');
  if (problems) ui.print(c.yellow(`${problems} problem(s) found.`)); else ui.print(c.green('All good. Ember is ready.'));
  return problems === 0;
}
