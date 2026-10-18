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
- **Git built in:** takes a checkpoint before each task, `/rollback` undoes a whole session, and `/commit` writes the commit message for you.
- **Fixes its own mistakes:** after editing, it runs your tests, build and lint, then fixes what broke (up to 3 attempts).
- **Starts new projects:** `ember new "a todo app with a REST API"` plans the project, writes the files, installs dependencies and runs the tests.
- **Explains code:** `ember explain server.js` gives a plain-language, read-only explanation.
- **Understands screenshots:** `/image shot.png`, or any image path in your message, is read by a local vision model.
- **Live preview:** `/preview` starts your dev server, takes a headless screenshot, and lets the vision model look at it. Browser errors are collected too.
- **Watch mode:** `ember watch` re-runs your checks on every save and offers to fix failures.
- **Parallel helpers:** big jobs are split into tasks. Coder helpers work on different files at the same time, then a tester runs your checks while a reviewer reads the diff. Use `/agents` to watch them.
- **Knows your project:** a local index of files and symbols (plus optional meaning-based search with `nomic-embed-text`) points the model at the right files (see [Project index](#project-index)).
- **Plugins:** add your own tools with a small JS file.
- **Optional extras:** web lookup and cloud models (xAI Grok or any OpenAI-compatible API). Both are off by default.

## Install

Requirements: **Node.js 18+**, Linux or macOS (Windows works once Ollama is installed), and ideally 8 GB+ of RAM.

One line (clone, install, done):

```bash
git clone https://github.com/annapreston7991-cell/ember.git ~/ember && ~/ember/install.sh
```

Then type **`ember`** in any project folder. The first run sets everything up for you: it installs and starts Ollama (asking first) and downloads a coding model that fits your machine. After that it drops you straight into the chat. You can also run `ember setup` yourself at any time.

The same thing by hand:

```bash
git clone https://github.com/annapreston7991-cell/ember.git
cd ember
npm install -g .        # puts `ember` on your PATH
ember                   # first run = setup, then the chat
```

Or run it without a global install: `npx github:annapreston7991-cell/ember`.

### If `ember` isn't found, or npm says EACCES

Global npm installs fail when npm's global folder belongs to root (`EACCES: permission denied`), or they succeed but the `ember` command isn't on your PATH. `install.sh` fixes both automatically. To do it by hand, give npm a folder you own (never use `sudo npm`):

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
cd ~/ember && npm install -g .
which ember && ember --version
```

If you use `nvm`, global installs already go to a folder you own; just make sure the same Node version is active (`nvm use --lts`). To check where npm puts global commands, run `npm prefix -g`; the `ember` command lives in its `bin/` folder.

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

4. Downloads the model with a progress bar.
5. Optionally downloads the vision model `qwen2.5vl:3b` (~3 GB) so Ember can read screenshots. Use `ember setup --vision` to get it without the question.
6. Optionally downloads the embedding model `nomic-embed-text` (~270 MB) so the [project index](#project-index) can search by meaning.
7. Saves settings to `~/.ember/config.json`, readable only by you (mode 600).

To choose a model yourself, run `ember setup --model qwen2.5-coder:14b`. Any Ollama model works (for example `--model llama3.1:8b`).

## Usage

```bash
cd my-project
ember                                  # interactive session
ember "add a /health route to server.js and a test for it"
ember -y "run the tests and fix whatever fails"   # auto-approve (dangerous commands still ask)
ember doctor                           # check Ollama, model, config
ember index                            # build/update the project index
ember new "a URL shortener with Express and SQLite"
ember explain src/auth.js              # or: ember explain "how does login work?"
ember watch                            # tests on every save, fixes on request
ember "the layout breaks like this: ./screenshots/bug.png"
```

### In the chat

| Command | What it does |
|---|---|
| `/help` | show commands |
| `/model [name]` | show or switch the model (offers to pull it). `/model cloud:grok-4` switches to xAI |
| `/models` | list installed models |
| `/plan` | show the current plan |
| `/preview [/path\|url] [question]` | start the dev server, screenshot the page, describe it, and collect browser errors (`/preview stop` stops the server) |
| `/agents [on\|off]` | show the parallel helpers (planner, coders, tester, reviewer), or turn them on/off |
| `/undo` | revert the last file change |
| `/rollback` | undo everything Ember changed this session (restores the git checkpoint) |
| `/commit` | commit all changes with an AI-written message (you approve or edit it) |
| `/fix` | run the project's checks now and fix failures |
| `/explain <file or question>` | plain-language explanation, read-only |
| `/image <path> [what to do]` | show Ember a screenshot |
| `/plugins` | list loaded plugin tools |
| `/clear` | start a fresh conversation |
| `/remember <note>` | save a preference (`--project` for this repo only) |
| `/forget <words>` | forget matching notes |
| `/memory` | show what Ember knows about you and this project |
| `/prefs` | show preferences, approval habits and settings |
| `/index [query]` | rebuild the project index, or show the files that match a query |
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
- **No network beyond Ollama by default.** Ember talks only to your local Ollama server (`http://127.0.0.1:11434`). Web lookup and cloud models are opt-in, and Ember tells you when they are on.
- **Git safety net.** In git repos, a checkpoint is taken before each task (see below).

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

## Project index

Ember keeps a small index of your project in `.ember/index/`. It holds a file map, the symbols in each file (functions, classes, routes, headings) and the important words. When you send a message, Ember looks up the files that fit best and adds them to your message as hints. The model then opens the right files first instead of guessing. The model can also call a read-only `find_code` tool.

- **Automatic and incremental:** the index is built the first time you open Ember in a project with up to 3,000 files. After that, only files whose size, mtime or content changed are re-read, and it updates again after Ember edits files. It follows `.gitignore` and skips `node_modules`, lockfiles and binaries.
- **Optional embeddings:** with `nomic-embed-text` installed (`ember setup` offers it, or run `ember index --embed`), Ember also embeds 60-line chunks of each file and blends keyword and meaning-based scores. Only changed files are embedded again.
- **Stays out of git:** `.ember/.gitignore` keeps the index out of your commits. The index never leaves your machine.

```bash
ember index                         # build or update (keywords + symbols)
ember index --embed                 # also embed (pulls nomic-embed-text after asking)
ember index --query "where are sessions created"
ember index --clear                 # delete the index
```

Turn the index off with `"index": { "enabled": false }`. Turn just the embeddings off with `"embeddings": false`.

Measured on Ember's own repo (44 files) with 12 "where is X?" questions, each with one correct file. Keywords and symbols alone put the right file first 10 times out of 12. With embeddings it was first 11 times out of 12. Both put it in the top 3 every time. A query takes about 4 ms with keywords and about 40 ms with embeddings on CPU. Building the embeddings the first time took 46 s on this CPU-only box, and later updates only cost a second or two.

## Parallel helpers

When a request has several parts ("create add.js…, create sub.js…, and div.js…"), Ember works as a small team:

1. **Planner:** splits the job into tasks and lists the files each task touches. Neighbouring tasks on the same files are merged.
2. **Coders:** tasks on *different* files run at the same time, up to `team.maxParallel` (2 by default). A task with no file list runs on its own.
3. **Tester and reviewer:** after the coders finish, they run side by side. The tester runs your checks and fixes failures (the self-fix loop). The reviewer reads the diff and lists possible bugs. Its notes are shown to you but never applied automatically.

Safety stays the same:

- **File locks:** a file belongs to the helper that changed it first until that helper is done. Other helpers are told to leave it alone. If a file changed while a helper waited, that helper has to read it again.
- **One prompt at a time:** every diff, approval and command goes through a single queue. Prompts never overlap, and `--yes`, the allowlist and the destructive-command check work exactly as usual.
- **Shared undo:** `/undo` and `/rollback` cover everything the helpers changed.

`/agents` shows each helper's task, files, model, time and result. `/agents off` turns helpers off (big jobs then run as sequential steps). In config, use `"team": { "enabled": true, "maxParallel": 2, "review": true }`.

Ollama runs requests from several helpers at the same time if the machine has room (see `OLLAMA_NUM_PARALLEL`). On a GPU this cuts wall time. On a CPU-only machine the helpers share the same cores, so expect better focus per task rather than more speed. On the 8-core CPU test box, a 4-file job with 7B took 47 s and 53 s with helpers, against 23 s and 55 s as sequential steps. The 23 s sequential run was quick because the model skipped three of the four files. Both helper runs wrote all four files.

## Git: checkpoints, rollback, commits

In a git repository, Ember snapshots your working tree **before every task**. The snapshot includes untracked files but not ignored ones like `.env`. It is stored as a hidden commit under `refs/ember/<session>/<n>` and is built with a throwaway index, so **your branch, HEAD and staged changes are never touched**.

- `/rollback` shows which files would be reverted, deleted or restored, asks you, and then puts the folder back the way it was when the session started. The checkpoint ref is kept, so you can still look at it with `git show refs/ember/...`.
- `/commit` reads the pending diff, asks the model for a message (a summary line of 72 characters or fewer plus short bullets), and shows it to you. You answer **y**, **n**, or **e** to type your own. Then it runs `git add -A && git commit`.
- Outside git, `/rollback` falls back to undoing each file change from the session's backups.
- To turn checkpoints off, set `"git": { "checkpoints": false }`. Clean them up with `git for-each-ref --format='%(refname)' refs/ember/ | xargs -n1 git update-ref -d`.

## Self-fix loop

When a task changes files, Ember finds your project's checks and runs them (`typecheck`, `lint`, `build`, `test` from `package.json` using npm, pnpm, yarn or bun, or `pytest`, `go test`, `cargo test`). If one fails, Ember sends the error output back to the model and lets it fix the problem, then checks again, up to `selfFix.maxAttempts` times (default 3). Every check is a normal command, so **the usual approval rules apply**: you are asked unless it is allowlisted or you chose "always", and you can decline to skip the checks.

- Set `"checks": { "commands": ["make check"] }` to use your own commands.
- Turn it off with `"selfFix": { "enabled": false }`, or use `--no-fix` for a single run. `/fix` runs it on demand.

## New projects: `ember new`

```bash
ember new "a tiny REST API for notes with tests"     # folder: a-tiny-rest-api
ember new "landing page for my bakery" --dir bakery
```

Ember creates the folder and runs `git init`. It then plans the project, writes a `package.json` (or the equivalent) with `start` and `test` scripts, the code, tests, a README and a `.gitignore`. It installs dependencies (asking first) and runs the tests, fixing any failures. When it finishes, `cd` into the folder and run `ember` to keep building.

## Explain mode

`ember explain <file|folder|question>` or `/explain …` switches to a read-only toolset (`list_dir`, `read_file`, `search`) and a plain-language style. Ember cannot edit files or run commands in this mode.

## Screenshots and images

Use `/image path/to/shot.png fix the overlap`, or put any `.png`, `.jpg`, `.webp` or `.gif` path in your message. A local vision model (`visionModel`, default `qwen2.5vl:3b`; `llava` works too) describes the image precisely, including any error text, and that description is passed to the coding model. This means any coding model can "see." If the vision model isn't downloaded yet, Ember offers to download it the first time. Images are only read from paths you type.

## Live preview

`/preview` (or `ember preview [/path] [question]`) gives Ember eyes on your running app:

1. **Starts your dev server.** It looks for a `dev`, `start`, `serve` or `preview` script in `package.json` (npm, pnpm, yarn or bun), Django's `manage.py`, or a folder with `index.html`. A folder with `index.html` gets a small built-in static server on 127.0.0.1. Ember **asks before starting the command**, unless it's allowlisted or you used `--yes`. It reads the URL from the server output, or probes the usual port for Vite, Next, Astro and the rest.
2. **Takes a headless screenshot.** If your machine has Chrome, Chromium, Edge or Brave, nothing else is needed. If Playwright or Puppeteer is installed in the project or in `~/.ember/tools`, Ember uses it. With no browser at all, Ember offers to install Playwright + Chromium (~150 MB) into `~/.ember/tools`, **after asking**. If you say no, it falls back to a plain HTTP check.
3. **Looks at the page.** The local vision model (`qwen2.5vl:3b`, downloaded only after asking) describes what's on screen. Console errors, page errors and failed requests are collected with the screenshot. All of this goes into the conversation.

`/preview /checkout why is the total wrong?` hands the question and the preview to the agent, which can then fix the code. While the preview runs, the agent also gets a `preview_page` tool, so it can check the page again after a UI change. Screenshots are saved in `.ember/cache/preview/`, which is kept out of git. `/preview stop`, or quitting Ember, stops the dev server.

Set `"preview": { "command": "make serve", "port": 8080, "width": 1280, "height": 800 }` in config for anything Ember can't detect.

## Watch mode

`ember watch` lists the checks it will run and asks once. After that it re-runs them whenever a file changes, ignoring `node_modules`, `.git` and build folders. It uses polling, so it works on every OS and Node 18. When a check fails it shows the error and asks **"Ask Ember to fix it?"**. Fixes go through the normal diff approvals. Press Ctrl+C to stop.

## Web lookup (optional, off by default)

Set `"web": { "enabled": true }` in `~/.ember/config.json` to give Ember two tools:

- `web_search`, which uses DuckDuckGo's HTML page
- `web_fetch`, which returns a page's readable text

Ember asks before **each** lookup (or "always" for the session). Local and private addresses are blocked.

## Cloud models (optional)

Local Ollama is always the default. If you want a bigger model for a hard task, you can switch to any OpenAI-compatible API:

```bash
export XAI_API_KEY=...            # from console.x.ai
ember -m cloud:grok-4 "refactor the auth module"
# or inside a session:
/model cloud:grok-4
/model qwen2.5-coder:7b           # back to local
```

The built-in providers are `grok` (xAI, `XAI_API_KEY`), `openai` (`OPENAI_API_KEY`) and `openrouter` (`OPENROUTER_API_KEY`). Use `cloud:<provider>:<model>` to pick one, for example `cloud:openai:gpt-4.1`. To add your own endpoint, such as LM Studio, vLLM or a company gateway:

```json
"providers": { "lab": { "baseUrl": "http://10.0.0.5:8000/v1", "apiKeyEnv": "LAB_KEY" } }
```

Keys are read **only** from environment variables or from `~/.ember/config.json` (`"providers": { "grok": { "apiKey": "..." } }`). Ember writes that file with permissions 600, and `ember doctor` warns you if it is readable by others. When a cloud model is active, Ember warns that your prompts and the code it reads are sent to that provider.

## Plugins

A plugin is one JS module in `~/.ember/plugins/` (all projects) or `<project>/.ember/plugins/` (one project):

```js
export default {
  name: 'todo_scan',                                   // tool name the model calls
  description: 'List TODO and FIXME comments',          // shown to the model
  parameters: { type: 'object', properties: { tag: { type: 'string' } } },
  readOnly: true,                                       // false (default) = ask before each call
  async run(args, ember) {
    // ember.root, ember.resolve(path), ember.readFile(path),
    // ember.writeFile(path, text)  -> normal diff + approval
    // ember.exec(command)          -> normal command approval
    // ember.print(text)
    return 'result text for the model';
  }
};
```

A full example is in [`examples/plugins/todo-scan.js`](examples/plugins/todo-scan.js). Project plugins are code from the repository, so the first time Ember sees one (and every time its contents change) it **asks whether you trust it** and remembers your answer by file hash. A plugin can't reuse a built-in tool name. `/plugins` lists what is loaded. Turn plugins off with `"plugins": { "enabled": false }`.

## Speed

Ember is tuned for running on an ordinary laptop:

- **The model stays loaded.** Every request sends `keep_alive` (default `30m`, set with `keepAlive`), and the REPL loads the model in the background while you type.
- **Prompts stay cache-friendly.** The system prompt and tool list were cut by about a third, and they stay byte-identical across turns. History is only ever appended to, and it is trimmed rarely but deeply. Together these let Ollama reuse its prompt cache instead of re-reading everything.
- **Quick jobs use a small model.** `ember setup` adds a small helper model (`fastModel`, e.g. `qwen2.5-coder:1.5b`) when your main model is 7B or larger. Commit messages, explain mode and memory notes go to the helper; coding stays on the main model. Change this with `"router": { "explain": "fast" | "main", "commit": ..., "memory": ... }`.
- **Big jobs become focused steps.** Requests with four or more actions, a numbered list, or "build an app with…" are planned into 2–6 steps. Each step runs with a short, fresh context. Smaller requests run in one go, because splitting them was measured to be slower.
- **Better hardware detection.** Ember detects NVIDIA (`nvidia-smi`), AMD (amdgpu sysfs or `rocm-smi`) and Apple Silicon unified memory. It picks the main model, the helper model and `num_ctx` (16K with 16 GB+ of VRAM, 8K otherwise) from what it finds.
- **Measure it yourself:** `node scripts/bench.mjs qwen2.5-coder:7b --fast qwen2.5-coder:1.5b`

Measured on a CPU-only test box (8 threads, 16 GB RAM, no GPU, `qwen2.5-coder:7b`, cold start). Model output length varies from run to run, so treat these as rough numbers:

| Job | Before | After (main only) | After (with helper) |
|---|---|---|---|
| Explain a small file | 17.7 s | 15.2 s | **2.0 s** |
| Commit message | 3.0 s | 3.3 s | 2.7 s (0.3 s once loaded) |
| Write a file + test, run `npm test` | 36.1 s | 27.7 s | 40.9 s* |
| Two follow-up questions | 11.3 s | 14.0 s | 13.4 s |

*The coding job always uses the main model. The spread between runs (27.7 s and 40.9 s) comes from the model choosing 4 or 6 tool calls. Prompt evaluation for the first request dropped by about 32% (758 to 518 tokens for explain). Loading the 7B model takes 6–8 s, which `keep_alive` and warm-up now avoid after the first time.

## Configuration

`~/.ember/config.json` is created by `ember setup`:

```json
{
  "model": "qwen2.5-coder:7b",
  "host": "http://127.0.0.1:11434",
  "numCtx": 8192,
  "keepAlive": "30m",
  "fastModel": "qwen2.5-coder:1.5b",
  "router": { "explain": "fast", "commit": "fast", "memory": "fast", "plan": "main", "review": "main" },
  "steps": { "enabled": true, "maxSteps": 6 },
  "team": { "enabled": true, "maxParallel": 2, "review": true },
  "temperature": 0.2,
  "maxSteps": 25,
  "allowlist": ["ls", "cat", "git status", "git diff", "rg", "..."],
  "memory": { "enabled": true, "autoLearn": true, "maxPromptChars": 1800, "maxNotes": 60 },
  "approvals": { "suggestAfter": 3 },
  "git": { "checkpoints": true },
  "selfFix": { "enabled": true, "maxAttempts": 3, "timeoutSec": 300 },
  "checks": { "commands": [] },
  "visionModel": "qwen2.5vl:3b",
  "web": { "enabled": false },
  "cloud": { "defaultProvider": "grok" },
  "providers": {},
  "plugins": { "enabled": true },
  "index": { "enabled": true, "embeddings": true, "embedModel": "nomic-embed-text", "autoMaxFiles": 3000, "hints": 6 },
  "watch": { "debounceMs": 600, "intervalMs": 1000 }
}
```

Set `EMBER_HOME` to keep Ember's files somewhere other than `~/.ember`. `OLLAMA_HOST` is respected too.

## Development

```bash
npm install
npm test          # node:test suite: safety, parser, edit_file, memory, git, self-fix, cloud, web, plugins, vision, watch, `ember new` (mocked models)
node bin/ember.js --help
```

The code lives in `src/`:

- `agent.js`: agent loop, self-fix loop, explain mode
- `tools.js`, `safety.js`, `parser.js` (JSON tool-call fallback)
- `memory.js` and `style.js`: the learning layer
- `git.js`, `checks.js`, `vision.js`, `web.js`, `cloud.js`, `clients.js`, `plugins.js`, `watch.js`
- `pro.js`: the future Pro hook
- `ollama.js`, `setup.js`, `doctor.js`, `repl.js`, `cli.js`

## Roadmap

- [ ] Persistent sessions (`ember --resume`) and multi-level undo across sessions
- [ ] Branch-per-task mode and PR descriptions
- [ ] Optional sandboxed command runner (containers)
- [ ] MCP tool servers as plugins
- [ ] Native image input for coding models that support vision
- [ ] **Ember Pro** (planned, about $9/month through the LLYVerse store and Stripe):
  - hosted cloud-model credits, so you don't need your own API key
  - team memory shared across a team
  - premium plugins

  Ember itself stays free and local. The hook is `src/pro.js` (`isPro()`), and plugins can set `pro: true`. There is no billing code yet, and nothing that is free today will be gated.

## License

Released under the **LLYVerse License 1.0**. See [LICENSE](LICENSE). Credit to LLYVerse (https://llyverse.org) is required.
