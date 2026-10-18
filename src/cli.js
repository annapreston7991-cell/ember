/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { OllamaClient, ensureServer } from './ollama.js';
import { Agent } from './agent.js';
import { Memory } from './memory.js';
import { UI, c } from './ui.js';
import { runSetup } from './setup.js';
import { runDoctor } from './doctor.js';
import { memoryCommand } from './memoryview.js';
import { runRepl, runOneShot, explainPrompt } from './repl.js';
import { clientFor } from './clients.js';
import { loadPlugins } from './plugins.js';
import { runWatch } from './watch.js';
import { NEW_PROJECT_PROMPT } from './prompt.js';
import { git } from './git.js';
import { configPermsOk } from './cloud.js';
import os from 'node:os';
import { saveConfig } from './config.js';
import { enableDebug, debugHeader, dlog } from './debug.js';
import { CONFIG_VERSION, offerExtras, applyLowMemory, modelWarnings } from './models.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const USAGE = `${c.bold().yellow('Ember')} ${pkg.version} — a local AI coding agent (part of the LLYVerse)

Usage
  ember                     start an interactive session in this folder
  ember "add a dark mode"   do one task and exit
  ember setup [--model m]   install/start Ollama, pick a coding model, offer optional extras (re-runnable)
  ember plan ["idea"]       talk through an app/website idea; Ember writes .ember/plan.md for you to approve
  ember build               Ember builds the approved plan task by task (resumable; Ctrl+C stops safely)
  ember doctor              check Ollama, the model and your config
  ember pro [status|activate <key>|deactivate]   Ember Pro (cloud models, team memory, premium plugins)
  ember serve               JSON-RPC over stdio for editors (used by the VS Code extension)
  ember voice [--file talk.wav] [--no-speak]   talk to Ember (local speech-to-text, optional speech)
  ember preview [/path] [question]   start the dev server, screenshot it, describe it (vision)
  ember index [--embed|--clear|--query "text"]   build/update the project index (.ember/index)
  ember new "<idea>"        scaffold a new working project in a new folder
  ember explain <file|q>    plain-language explanation (read-only)
  ember watch               re-run tests/build on every change and offer fixes
  ember memory [show|prefs|remember|forget|edit|reset|on|off|path]

Options
  -m, --model <name>   use a specific model for this run (cloud:grok-4 for xAI)
      --dir <name>     folder name for ember new
      --no-fix         skip the self-fix loop (tests/build after edits)
      --vision         (setup) also download the vision model for screenshots
  -y, --yes            auto-approve file changes and commands (dangerous ones still need you)
  -C, --cwd <dir>      project folder (default: current folder)
      --host <url>     Ollama URL (default http://127.0.0.1:11434)
      --no-memory      don't read or write memory for this run
      --debug          log raw model replies and tool decisions to ~/.ember/logs (or EMBER_DEBUG=1)
  -v, --version        print the version
  -h, --help           show this help
`;

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '-m' || a === '--model') opts.model = next();
    else if (a.startsWith('--model=')) opts.model = a.slice(8);
    else if (a === '-y' || a === '--yes') opts.yes = true;
    else if (a === '-C' || a === '--cwd') opts.cwd = next();
    else if (a === '--host') opts.host = next();
    else if (a === '--no-memory') opts.noMemory = true;
    else if (a === '--no-fix') opts.noFix = true;
    else if (a === '--vision') opts.vision = true;
    else if (a === '--dir') opts.dir = next();
    else if (a === '--file') opts.file = next();
    else if (a === '--no-speak') opts.noSpeak = true;
    else if (a === '--debug') opts.debug = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--') { opts._.push(...argv.slice(i + 1)); break; }
    else opts._.push(a);
  }
  return opts;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.version) { console.log(pkg.version); return 0; }
  if (opts.help) { console.log(USAGE); return 0; }
  const root = path.resolve(opts.cwd || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const ui = new UI({ yes: !!opts.yes });
  const [cmd, ...rest] = opts._;
  if ((opts.debug || /^(1|true|yes)$/i.test(process.env.EMBER_DEBUG || '')) && cmd !== 'serve') {
    const f = enableDebug();
    debugHeader({ version: pkg.version, cfg: loadConfig(), extra: { argv } });
    ui.print(c.gray(`  (debug log: ${f})`));
  } else if (opts.debug || process.env.EMBER_DEBUG) { enableDebug(); debugHeader({ version: pkg.version, cfg: loadConfig(), extra: { argv } }); }

  try {
    if (cmd === 'setup') return (await runSetup({ ui, model: opts.model, yes: opts.yes, vision: opts.vision })) ? 0 : 1;
    if (cmd === 'doctor') return (await runDoctor({ ui, root })) ? 0 : 1;
    if (cmd === 'memory') { await memoryCommand({ ui, root, args: rest, yes: opts.yes }); return 0; }
    if (cmd === 'help') { console.log(USAGE); return 0; }
    if (cmd === 'index') return await indexCommand({ ui, root, args: rest, cfg: loadConfig() });
    if (cmd === 'pro') { const { proCommand } = await import('./pro.js'); return await proCommand({ ui, args: rest, cfg: loadConfig() }); }
    if (cmd === 'serve') {
      // Editors talk JSON-RPC on stdin/stdout, so nothing else may print to stdout.
      const { runServe } = await import('./serve.js');
      const scfg = loadConfig();
      if (opts.model) scfg.model = opts.model;
      if (opts.host) scfg.host = opts.host;
      if (opts.noMemory) scfg.memory = { ...scfg.memory, enabled: false };
      if (opts.noFix) scfg.selfFix = { ...scfg.selfFix, enabled: false };
      return await runServe({ root, yes: !!opts.yes, cfg: scfg, version: pkg.version });
    }

    const cfg = loadConfig();
    if (opts.model) cfg.model = opts.model;
    if (opts.host) cfg.host = opts.host;
    if (opts.noMemory) cfg.memory = { ...cfg.memory, enabled: false };
    if (opts.noFix) cfg.selfFix = { ...cfg.selfFix, enabled: false };
    let { client, cloud } = clientFor(cfg.model, cfg);
    if (cloud) {
      if (!(await client.hasModel())) { ui.error(`No API key for ${client.label}. Set ${client.p.apiKeyEnv} in your environment, or switch back with --model qwen2.5-coder:7b.`); return 1; }
      if (client.p.apiKey && !process.env[client.p.apiKeyEnv] && !configPermsOk()) ui.warn('Your config holds an API key but is readable by others. Run: chmod 600 ~/.ember/config.json');
    } else {
      // First run (no config) or the model isn't there: run setup automatically, then carry on.
      const up = await ensureServer(client);
      const ready = up && cfg._exists && (await client.hasModel(cfg.model).catch(() => false));
      const usable = up && opts.model && (await client.hasModel(cfg.model).catch(() => false));
      if (!ready && !usable) {
        ui.print(c.yellow(cfg._exists ? `Model ${cfg.model} isn't available yet, so let's finish setup first.` : 'Welcome to Ember! First-time setup: this gets Ollama and a coding model ready (one time).'));
        ui.print('');
        const ok = await runSetup({ ui, model: opts.model || (cfg._exists ? cfg.model : undefined), yes: opts.yes, host: opts.host });
        if (!ok) { ui.error(`Setup didn't finish. Fix the issue above, then run ${c.bold('ember')} again (or ${c.bold('ember doctor')}).`); return 1; }
        ui.print('');
        const fresh = loadConfig();
        cfg.model = opts.model || fresh.model;
        cfg._exists = true;
        ({ client, cloud } = clientFor(cfg.model, cfg));
      }
    }

    if (!cloud) {
      // Updated from an older Ember: offer the new optional models once (embeddings, vision, fast model).
      if (cfg._exists && (cfg.configVersion || 1) < CONFIG_VERSION) {
        ui.print(c.yellow(`Ember ${pkg.version} can use a few optional models you don't have yet:`));
        const { pullWithProgress } = await import('./setup.js');
        await offerExtras({ ui, client, cfg, yes: opts.yes, interactive: !!process.stdin.isTTY, pull: (m) => pullWithProgress(client, m, ui) });
        const saved = loadConfig();
        saved.configVersion = CONFIG_VERSION;
        if (cfg.fastModel && !saved.fastModel) saved.fastModel = cfg.fastModel;
        saveConfig(saved);
        ui.print(c.gray(`  (asked once; run ${c.bold('ember setup')} any time to add extras, ${c.bold('ember doctor')} to see what's missing)`));
        ui.print('');
      }
      if (applyLowMemory(cfg)) {
        client.keepAlive = cfg.keepAlive;
        dlog('decision', { what: 'low-memory mode: one model, no parallel helpers, keep_alive ' + cfg.keepAlive, ramGB: +(os.totalmem() / 1024 ** 3).toFixed(1) });
      }
      const running = await client.listRunning?.().catch(() => []) || [];
      for (const w of modelWarnings({ model: cfg.model, running })) ui.warn(w);
    }

    // `ember new`: make the folder first so the agent's project root is the new project.
    let projectRoot = root;
    if (cmd === 'new') {
      const idea = rest.join(' ').trim();
      if (!idea) { ui.error('Usage: ember new "a todo app with a REST API"'); return 1; }
      const slug = (opts.dir || idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-')) || 'ember-app';
      projectRoot = path.join(root, slug);
      if (fs.existsSync(projectRoot) && fs.readdirSync(projectRoot).length) { ui.error(`${projectRoot} already exists and is not empty. Use --dir <name>.`); return 1; }
      fs.mkdirSync(projectRoot, { recursive: true });
      git(projectRoot, ['init', '-q']);
      ui.ok(`Created ${projectRoot}`);
    }

    const memory = new Memory(projectRoot, cfg);
    const { tools: pluginTools, skipped } = await loadPlugins({
      root: projectRoot, cfg,
      confirmTrust: async (file) => (await ui.confirm(`Project plugin ${path.relative(projectRoot, file)} wants to add a tool. It is code from this repo and will run on your machine. Trust it?`, { allowAlways: false })) === 'y'
    });
    for (const sk of skipped) ui.print(c.gray(`  (plugin ${path.basename(sk.file)} skipped: ${sk.reason})`));
    const agent = new Agent({ cfg, root: projectRoot, ui, client, memory, extraTools: pluginTools });
    await agent.init();

    if (cmd === 'new') {
      await runOneShot({ agent, ui, prompt: NEW_PROJECT_PROMPT(rest.join(' ').trim(), projectRoot) });
      ui.print('');
      ui.print(`Next: ${c.yellow(`cd ${path.relative(process.cwd(), projectRoot) || '.'}`)} then ${c.yellow('ember')} to keep building.`);
      return 0;
    }
    if (cmd === 'explain') {
      const q = rest.join(' ').trim();
      if (!q) { ui.error('Usage: ember explain <file or question>'); return 1; }
      await agent.explain(explainPrompt(q, projectRoot));
      return 0;
    }
    if (cmd === 'preview') {
      const { previewFlow } = await import('./repl.js');
      const { stopPreview } = await import('./preview.js');
      try { await previewFlow({ agent, ui, cfg, rest: rest.join(' ') }); }
      finally { await stopPreview(agent).catch(() => {}); }
      return 0;
    }
    if (cmd === 'voice') {
      const { runVoice } = await import('./voice.js');
      return await runVoice({ agent, ui, cfg, file: opts.file && path.resolve(opts.file), speakOut: !opts.noSpeak && cfg.voice?.tts !== false });
    }
    if (cmd === 'watch') return await runWatch({ agent, ui, cfg, root: projectRoot });
    if (cmd === 'plan' || cmd === 'build') {
      const { planSession, buildSession } = await import('./plan.js');
      const { buildPreview } = await import('./repl.js');
      const controller = new AbortController();
      ui.onInterrupt = () => controller.abort();
      process.on('SIGINT', () => controller.abort());
      try {
        if (cmd === 'plan') {
          const plan = await planSession({ agent, ui, idea: rest.join(' ').trim(), signal: controller.signal, yes: opts.yes });
          if (plan?.status === 'approved' && !opts.yes && process.stdin.isTTY && (await ui.confirm('Start building now?', { allowAlways: false })) === 'y') await buildSession({ agent, ui, signal: controller.signal, preview: buildPreview({ agent, ui, cfg }) });
        } else await buildSession({ agent, ui, signal: controller.signal, yes: opts.yes, preview: buildPreview({ agent, ui, cfg }) });
      } catch (e) { if (!controller.signal.aborted) throw e; ui.warn('Stopped.'); }
      return 0;
    }

    if (opts._.length) {
      // `ember fix the tests` and `ember "fix the tests"` both work.
      await runOneShot({ agent, ui, prompt: opts._.join(' ') });
      return 0;
    }
    // No arguments: always the interactive REPL (it also reads piped lines, e.g. `echo /exit | ember`).
    await runRepl({ agent, ui, cfg, client });
    return 0;
  } finally {
    ui.close();
  }
}

async function indexCommand({ ui, root, args, cfg }) {
  const { updateIndex, retrieve, formatHits, indexDir, makeEmbedder } = await import('./indexer.js');
  const { OllamaClient } = await import('./ollama.js');
  const fsm = await import('node:fs');
  const dir = indexDir(root);
  if (args.includes('--clear')) { fsm.rmSync(dir, { recursive: true, force: true }); ui.ok(`Removed ${dir}`); return 0; }
  const ic = cfg.index || {};
  const client = new OllamaClient(cfg.host, { keepAlive: cfg.keepAlive });
  const model = ic.embedModel || 'nomic-embed-text';
  let haveEmbed = await client.hasModel(model, { timeoutMs: 2000 }).catch(() => false);
  if (args.includes('--embed') && !haveEmbed) {
    if ((await ui.confirm(`Download the embedding model ${model} (~270 MB)?`, { allowAlways: false })) === 'y') {
      const { pullWithProgress } = await import('./setup.js');
      await pullWithProgress(client, model, ui); haveEmbed = true;
    }
  }
  const useEmbed = haveEmbed && ic.embeddings !== false;
  const qi = args.indexOf('--query');
  const emb = useEmbed ? makeEmbedder(client, model) : null;
  if (emb && !fsm.existsSync(`${dir}/vectors.json`)) ui.print(c.gray(`  embedding the project with ${model} (first time only; later runs only embed changed files)…`));
  const stats = await updateIndex(root, emb ? { embed: emb.embed, embedModel: model } : {});
  ui.ok(`Index: ${stats.files} files, ${stats.symbols} symbols (${stats.changed} updated, ${stats.removed} removed${useEmbed ? `, ${stats.embedded} chunks embedded with ${model}` : ', keywords + symbols only'}) in ${(stats.ms / 1000).toFixed(1)}s`);
  ui.print(c.gray(`  stored in ${dir}`));
  if (qi >= 0 && args[qi + 1]) {
    const hits = await retrieve(root, args.slice(qi + 1).join(' '), { k: 8, embedQuery: emb ? emb.embedQuery : null });
    ui.print(formatHits(hits, 2000) || 'No matches.');
  }
  return 0;
}
