# 🔥 Ember

**A command-line AI coding agent that runs entirely on your own computer.**

Ember plans, reads and writes files, runs commands, and builds projects right in your terminal, the way cloud coding agents do. The difference is that its model runs locally through [Ollama](https://ollama.com). There are no API keys and no per-use costs, and your code never leaves your machine.

> Ember is part of the **LLYVerse** · https://llyverse.org

---

## Features

- **Agent loop:** plans the work, looks at your code (`list_dir`, `read_file`, `search`), changes it (`write_file`, `edit_file`), runs things (`run_command`), checks the result, and keeps a live plan/todo list.
- **Local model:** `ember setup` installs Ollama if needed, checks your RAM/GPU, and pulls a coding model that fits (Qwen2.5-Coder 1.5B to 32B).
- **You stay in control:** shows a colored diff before every file change and asks before every command. `/undo` reverts the last change.
- **Learns you:** remembers your preferences, picks up your repo's style, and adapts over time. All of this stays on your machine (see [Ember learns you](#ember-learns-you)).
- **Two ways to use it:** an interactive chat (`ember`) or one-shot tasks (`ember "add a /health route"`).
- **Works with any model:** uses native tool calling when the model supports it and a JSON tool mode when it doesn't.

## Install

Requirements: **Node.js 18+**, Linux or macOS (Windows works once Ollama is installed), and ideally 8 GB+ of RAM.

```bash
git clone https://github.com/annapreston7991-cell/ember.git
cd ember
npm install -g .        # gives you the `ember` command (use sudo if your npm needs it)
ember setup             # installs/starts Ollama and downloads a coding model
```

Or run it without a global install:

```bash
npx github:annapreston7991-cell/ember setup
```

### What `ember setup` does

1. Looks for Ollama. If it's missing, it offers to run the official installer (`curl -fsSL https://ollama.com/install.sh | sh`) and **asks first**. On Windows it prints the download link.
2. Makes sure the Ollama server is running and starts `ollama serve` if not.
3. Checks your memory and GPU and picks a model:

   | Machine | Model |
   |---|---|
   | < 6 GB RAM | `qwen2.5-coder:1.5b` |
   | 6–12 GB RAM, CPU only | `qwen2.5-coder:3b` |
   | 12 GB+ RAM or a 6 GB+ GPU (default) | `qwen2.5-coder:7b` |
   | 10 GB+ GPU / Apple Silicon 32 GB+ | `qwen2.5-coder:14b` |
   | 22 GB+ GPU / Apple Silicon 64 GB+ | `qwen2.5-coder:32b` |

4. Downloads the model with a progress bar and saves settings to `~/.ember/config.json`.

To choose a model yourself, run `ember setup --model qwen2.5-coder:14b`. Any Ollama model works (for example `--model llama3.1:8b`).

## Usage

```bash
cd my-project
ember                                  # interactive session
ember "add a /health route to server.js and a test for it"
ember -y "run the tests and fix whatever fails"   # auto-approve (dangerous commands still ask)
ember doctor                           # check Ollama, model, config
```

### In the chat

| Command | What it does |
|---|---|
| `/help` | show commands |
| `/model [name]` | show or switch the model (offers to pull it) |
| `/models` | list installed models |
| `/plan` | show the current plan |
| `/undo` | revert the last file change |
| `/clear` | start a fresh conversation |
| `/remember <note>` | save a preference (`--project` for this repo only) |
| `/forget <words>` | forget matching notes |
| `/memory` | show what Ember knows about you and this project |
| `/prefs` | show preferences, approval habits and settings |
| `/exit` | quit (Ember learns from the session first) |

Press **Ctrl+C** to stop a running answer, or press it twice at the prompt to quit.

### Project instructions: `EMBER.md`

If an `EMBER.md` file is in the folder where you run Ember, it is added to every prompt. Use it for project rules such as "This is an Express + EJS app. Use better-sqlite3. Run `npm test` after changes."

## Safety model

Ember works the way a careful pair programmer would:

- **Stays in your project.** Every file path is resolved against the project folder. `..`, absolute paths, `~`, and symlinks that point outside are all blocked.
- **Diff before every change.** You see a colored diff and answer **y**es, **n**o, or **a**lways (for the rest of the session). When you say no, you can add a short reason, which goes back to the model.
- **Ask before every command.** Read-only commands on the allowlist (`ls`, `cat`, `git status`, `git diff`, `rg`, …) run without asking. You can edit the `allowlist` in `~/.ember/config.json`. The allowlist never matches commands that use pipes, redirects, `;`, `&&` or `$(…)`.
- **Dangerous commands need a typed "yes."** This covers commands like `rm -rf`, `sudo`, `mkfs`, `dd of=/dev/…`, `git push --force`, `git reset --hard`, `curl … | sh` and fork bombs. You must type `yes` for these, **even with `--yes`**. Without a terminal they are refused.
- **Undo.** Each change is backed up (`~/.ember/backups/`) and `/undo` restores it.
- **No network beyond Ollama.** Ember talks only to your local Ollama server (`http://127.0.0.1:11434` by default).

## Ember learns you

Ember adapts to how *you* work and keeps getting better at it. All of this stays on your computer, with no telemetry and no cloud.

**Where memory lives**

- `~/.ember/profile.json` holds your global preferences (languages, frameworks, code style, test habits, how much explanation you like, tone) and your approval habits.
- `<project>/.ember/memory.md` holds notes for one project. It is plain Markdown that you can edit by hand. Add `.ember/` to `.gitignore` if you don't want to commit it.

**How it learns**

- **What you say.** Statements like *"I prefer Tailwind"*, *"never use var"* or *"always run the tests first"* are noted right away, and Ember shows you what it noted. Saying "this project" or "this repo" scopes the note to that repo.
- **What you do.** When a session ends, Ember reviews what you accepted, rejected, undid, and **edited after Ember wrote it**. It then distills at most a few short, lasting notes using your local model. This only happens when the session actually told it something about you.
- **Your repo's style.** Every session it re-reads `.editorconfig`, Prettier and ESLint configs, `package.json` (module type, frameworks, test script, package manager), and samples existing code for indentation, quotes and semicolons.
- **Your approval habits.** If you keep approving the same safe kind of command (for example `npm test` three times in a row), Ember *asks* whether to add it to your allowlist. It never adds anything on its own.

**How it stays small and current**

- Each note is timestamped. Notes about the same thing share a key (indentation, quotes, package manager, "always/never X"), so **the newer note replaces the older one**.
- A note the model inferred can never override something you said yourself.
- Duplicates and near-duplicates are merged. When notes pile up, the model consolidates the learned ones, and the list is capped (`memory.maxNotes`, default 60 per scope).
- Each turn, only the most relevant notes go into the prompt, capped at `memory.maxPromptChars` (default 1800 characters).

**You're in charge**

```bash
ember memory              # show everything Ember knows
ember memory prefs        # preferences, approval habits, settings
ember memory remember "Use 2-space indentation"
ember memory remember --project "Deploys through a Cloudflare Tunnel"
ember memory forget indentation
ember memory edit         # edit global notes in $EDITOR (add --project for this repo)
ember memory reset        # delete all memory (--global or --project for one)
ember memory off          # opt out completely (ember memory on to re-enable)
ember --no-memory "..."   # one run without memory
```

In `~/.ember/config.json`, `"memory": { "enabled": false }` turns memory off and `"autoLearn": false` keeps memory while stopping automatic learning.

## Configuration

`~/.ember/config.json` is created by `ember setup`:

```json
{
  "model": "qwen2.5-coder:7b",
  "host": "http://127.0.0.1:11434",
  "numCtx": 8192,
  "temperature": 0.2,
  "maxSteps": 25,
  "allowlist": ["ls", "cat", "git status", "git diff", "rg", "..."],
  "memory": { "enabled": true, "autoLearn": true, "maxPromptChars": 1800, "maxNotes": 60 },
  "approvals": { "suggestAfter": 3 }
}
```

Set `EMBER_HOME` to keep Ember's files somewhere other than `~/.ember`. `OLLAMA_HOST` is respected too.

## Development

```bash
npm install
npm test          # node:test suite: path safety, tool-call parser, edit_file, memory, mocked agent loop
node bin/ember.js --help
```

The code lives in `src/`: `agent.js` (agent loop), `tools.js`, `safety.js`, `parser.js` (JSON tool-call fallback), `memory.js` and `style.js` (learning layer), `ollama.js`, `setup.js`, `doctor.js`, `repl.js`, `cli.js`.

## Roadmap

- [ ] Persistent sessions (`ember --resume`) and multi-level undo across sessions
- [ ] Image input for vision models (screenshots of UI bugs)
- [ ] Project-wide "build me an app" templates (Express, EJS, static sites)
- [ ] Git integration: commit with generated messages, branch per task
- [ ] Optional sandboxed command runner (containers)
- [ ] MCP tool servers
- [ ] Ember Pro add-ons in the LLYVerse store

## License

Released under the **LLYVerse License 1.0**. See [LICENSE](LICENSE). Credit to LLYVerse (https://llyverse.org) is required.
