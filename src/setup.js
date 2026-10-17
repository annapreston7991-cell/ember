/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import { spawnSync } from 'node:child_process';
import { OllamaClient, ollamaBinary, ensureServer } from './ollama.js';
import { detectHardware, pickModel } from './hardware.js';
import { loadConfig, saveConfig, configPath } from './config.js';
import { c } from './ui.js';

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export async function pullWithProgress(client, model, ui) {
  let lastStatus = '';
  let lastDraw = 0;
  await client.pull(model, (p) => {
    const now = Date.now();
    if (p.total && p.completed !== undefined) {
      if (now - lastDraw < 120 && p.completed !== p.total) return;
      lastDraw = now;
      const pct = Math.min(100, Math.floor((p.completed / p.total) * 100));
      const w = 28, fill = Math.round((pct / 100) * w);
      const bar = c.red('█'.repeat(fill)) + c.gray('░'.repeat(w - fill));
      ui.write(`\r  ${bar} ${String(pct).padStart(3)}%  ${fmtBytes(p.completed)} / ${fmtBytes(p.total)}   `);
    } else if (p.status && p.status !== lastStatus) {
      if (lastStatus.startsWith('pulling')) ui.write('\n');
      lastStatus = p.status;
      ui.print(c.gray(`  ${p.status}`));
    }
  });
  ui.print('');
}

export async function runSetup({ ui, model: forcedModel, yes }) {
  const cfg = loadConfig();
  ui.print(c.bold().yellow('Ember setup') + c.gray(' · everything runs on this computer, no API keys'));
  ui.print('');

  // 1. Ollama binary
  let bin = ollamaBinary();
  if (bin) ui.ok(`Ollama found at ${bin}`);
  else {
    ui.warn('Ollama is not installed. Ember uses Ollama to run AI models locally.');
    if (process.platform === 'win32') {
      ui.print('  Download and run the installer from ' + c.underline('https://ollama.com/download/windows'));
      ui.print('  Then open a new terminal and run ' + c.bold('ember setup') + ' again.');
      return false;
    }
    const cmd = 'curl -fsSL https://ollama.com/install.sh | sh';
    ui.print(`  Official install command: ${c.yellow(cmd)}`);
    if (process.platform === 'darwin') ui.print(c.gray('  (On macOS you can also use the app from https://ollama.com/download or `brew install ollama`.)'));
    const ok = yes ? 'y' : await ui.confirm('Install Ollama now with the official script? (it may ask for your password)', { allowAlways: false });
    if (ok !== 'y') { ui.print('  OK. Install it yourself, then run ' + c.bold('ember setup') + ' again.'); return false; }
    const r = spawnSync('bash', ['-c', cmd], { stdio: 'inherit' });
    bin = ollamaBinary();
    if (r.status !== 0 || !bin) { ui.error('Ollama install did not finish. See the messages above, or visit https://ollama.com/download'); return false; }
    ui.ok('Ollama installed');
  }

  // 2. Server
  const client = new OllamaClient(cfg.host);
  if (await client.version()) ui.ok(`Ollama server is running (${cfg.host})`);
  else {
    ui.info('Starting the Ollama server…');
    if (!(await ensureServer(client))) {
      ui.error(`Could not reach Ollama at ${cfg.host}. Try running ${c.bold('ollama serve')} in another terminal, then ember setup again.`);
      return false;
    }
    ui.ok('Ollama server started');
  }

  // 3. Hardware + model choice
  const hw = detectHardware();
  ui.ok(`Hardware: ${hw.ramGB} GB RAM${hw.gpu ? `, ${hw.gpu}${hw.vramGB ? ` (${hw.vramGB} GB VRAM)` : ''}` : ', no dedicated GPU detected'}`);
  const recommended = pickModel(hw);
  const model = forcedModel || recommended;
  ui.ok(`Model: ${c.bold(model)}${forcedModel ? c.gray(` (you chose it; recommended for this machine: ${recommended})`) : c.gray(' (picked for this machine; override with --model)')}`);

  // 4. Pull
  if (await client.hasModel(model)) ui.ok(`${model} is already downloaded`);
  else {
    ui.info(`Downloading ${model} (one time, this can take a while)…`);
    try { await pullWithProgress(client, model, ui); }
    catch (e) { ui.error(`Download failed: ${e.message}`); return false; }
    ui.ok(`${model} downloaded`);
  }

  // 5. Config
  cfg.model = model;
  saveConfig(cfg);
  ui.ok(`Saved settings to ${configPath()}`);
  const tools = await client.supportsTools(model);
  ui.print('');
  ui.print(c.bold('You are ready.') + ' Go to a project folder and run ' + c.yellow('ember') + ' or ' + c.yellow('ember "add a /health route"') + '.');
  if (tools === false) ui.print(c.gray('Note: this model has no native tool calling; Ember will use its JSON tool mode.'));
  return true;
}
