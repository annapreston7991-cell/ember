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
import { runRepl, runOneShot } from './repl.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const USAGE = `${c.bold().yellow('Ember')} ${pkg.version} — a local AI coding agent (part of the LLYVerse)

Usage
  ember                     start an interactive session in this folder
  ember "add a dark mode"   do one task and exit
  ember setup [--model m]   install/start Ollama and download a coding model
  ember doctor              check Ollama, the model and your config
  ember memory [show|prefs|remember|forget|edit|reset|on|off|path]

Options
  -m, --model <name>   use a specific Ollama model for this run
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
    if (cmd === 'setup') return (await runSetup({ ui, model: opts.model, yes: opts.yes })) ? 0 : 1;
    if (cmd === 'doctor') return (await runDoctor({ ui, root })) ? 0 : 1;
    if (cmd === 'memory') { await memoryCommand({ ui, root, args: rest, yes: opts.yes }); return 0; }
    if (cmd === 'help') { console.log(USAGE); return 0; }

    const cfg = loadConfig();
    if (opts.model) cfg.model = opts.model;
    if (opts.host) cfg.host = opts.host;
    if (opts.noMemory) cfg.memory = { ...cfg.memory, enabled: false };
    if (!cfg._exists && !opts.model) {
      ui.warn(`Ember isn't set up yet. Run ${c.bold('ember setup')} first (it installs Ollama and a coding model).`);
      return 1;
    }
    const client = new OllamaClient(cfg.host);
    if (!(await ensureServer(client))) {
      ui.error(`Can't reach Ollama at ${cfg.host}. Start it with ${c.bold('ollama serve')} or run ${c.bold('ember doctor')}.`);
      return 1;
    }
    if (!(await client.hasModel(cfg.model))) {
      ui.error(`Model ${cfg.model} isn't downloaded. Run ${c.bold(`ember setup --model ${cfg.model}`)}.`);
      return 1;
    }
    const memory = new Memory(root, cfg);
    const agent = new Agent({ cfg, root, ui, client, memory });
    await agent.init();

    if (opts._.length) {
      // `ember fix the tests` and `ember "fix the tests"` both work.
      await runOneShot({ agent, ui, prompt: opts._.join(' ') });
      return 0;
    }
    if (!process.stdin.isTTY && !opts.yes) {
      // Piped input: treat all of stdin as a single task.
      const chunks = [];
      for await (const ch of process.stdin) chunks.push(ch);
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return 0;
      ui.print(c.gray('(no terminal: file changes and commands will be declined; use --yes to allow them)'));
      ui.ask = async () => null; // stdin is used up; decline anything that needs approval
      await runOneShot({ agent, ui, prompt: text });
      return 0;
    }
    await runRepl({ agent, ui, cfg, client });
    return 0;
  } finally {
    ui.close();
  }
}
