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

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const USAGE = `${c.bold().yellow('Ember')} ${pkg.version} — a local AI coding agent (part of the LLYVerse)

Usage
  ember                     start an interactive session in this folder
  ember "add a dark mode"   do one task and exit
  ember setup [--model m]   install/start Ollama and download a coding model
  ember doctor              check Ollama, the model and your config
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

  try {
    if (cmd === 'setup') return (await runSetup({ ui, model: opts.model, yes: opts.yes, vision: opts.vision })) ? 0 : 1;
    if (cmd === 'doctor') return (await runDoctor({ ui, root })) ? 0 : 1;
    if (cmd === 'memory') { await memoryCommand({ ui, root, args: rest, yes: opts.yes }); return 0; }
    if (cmd === 'help') { console.log(USAGE); return 0; }
    if (cmd === 'index') return await indexCommand({ ui, root, args: rest, cfg: loadConfig() });

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
        const ok = await runSetup({ ui, model: opts.model || (cfg._exists ? cfg.model : undefined), yes: opts.yes, askVision: false, host: opts.host });
        if (!ok) { ui.error(`Setup didn't finish. Fix the issue above, then run ${c.bold('ember')} again (or ${c.bold('ember doctor')}).`); return 1; }
        ui.print('');
        const fresh = loadConfig();
        cfg.model = opts.model || fresh.model;
        cfg._exists = true;
        ({ client, cloud } = clientFor(cfg.model, cfg));
      }
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
    if (cmd === 'watch') return await runWatch({ agent, ui, cfg, root: projectRoot });

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
