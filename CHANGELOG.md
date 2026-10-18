<!--
  Copyright (c) 2026 LLYVerse — https://llyverse.org
  Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
-->
# Changelog

## v0.2.1 (2026-10-18)

### Fixed: "Ember is not writing files" on small models
- Replies that looked like a tool call but didn't parse were hidden and then thrown away, so you saw nothing and nothing was written. They are shown now.
- Tool calls written as text are read even when they're broken the way small models break them: a missing closing brace, an unterminated string, raw newlines, trailing commas, `<tool_call>` tags, `write_file(path=…, content=…)`, or other argument names (`file_path`, `code`, …). File content sent as a list of lines is accepted.
- When the model pastes code in the chat instead of saving it, Ember finds the file it belongs to and asks "Save this code to todo.py?". If no filename is given, it asks the model once more to call `write_file`.
- Models with ≤ 4B parameters get a short, strict system prompt with an example.
- Approvals: a stray Enter no longer counts as "no", and an empty answer asks again. When there's no input (piped stdin), Ember warns loudly instead of silently answering "no".
- Paths: `~/…` and a leading `/` (as in "/hello.py") now resolve inside the project.

### Setup and models
- Updating from an older config offers the missing extras once (embeddings, vision). `ember setup` can be re-run to add them and keeps your model. `ember doctor` lists missing optional models with the `ollama pull` command.
- Setup reuses a coding model you already have. `qwen2.5-coder:3b` is now recommended from 4 GB (Chromebooks included). The doctor warns that 1.5B is unreliable and shows other loaded models that compete for memory.
- Low-memory mode (≤ 6.5 GB): one model, no fast model or parallel helpers, and shorter `keep_alive`.

### Ollama errors
- No more bare "fetch failed": "Can't reach Ollama at <url>". Ember waits briefly for a starting server (with backoff) and offers to start `ollama serve`.
- Out-of-memory and crashed model loads are recognized and come with concrete advice.

### New: plan and build
- `ember plan` / `/plan`: clarifying questions, then a spec and task list in `.ember/plan.md` that you approve or edit.
- `ember build` / `/build`: builds task by task with git checkpoints, tests and self-fix. File writes and safe in-project commands are auto-approved. Risky commands still ask. It's resumable, and `/pause` and Ctrl+C stop safely.

### Debugging
- `ember --debug` / `EMBER_DEBUG=1` writes a redacted log to `~/.ember/logs`.

## v0.2.0 (2026-10-17)

### Faster
- Models stay loaded (`keep_alive`) and Ember warms the model up at startup.
- Prompts are trimmed and kept cache-stable, so first-call prompt tokens for `explain` dropped by 32%.
- A fast/smart model router sends small jobs (commit messages, explanations) to a fast model when you have one. On CPU, `explain` went from 17.7 s to 2.0 s.
- Big jobs run as focused steps. GPU detection is better. Measure it on your machine with `node scripts/bench.mjs`.

### Project index
- A local map of your project's files and symbols, with optional `nomic-embed-text` embeddings.
- Ember adds retrieval hints to each request and gets a `find_code` tool. New commands: `ember index` and `/index`.

### Parallel helpers
- For bigger tasks, a planner splits the work and coders run side by side on separate files.
- A tester and a reviewer then check the result in parallel.
- File locks and a single approval queue keep it safe. `/agents` shows what each helper is doing.

### Live preview
- Ember detects your dev server and starts it with your approval.
- It takes headless screenshots through system Chrome, Playwright or Puppeteer and reports browser console errors.
- A vision model can describe the page. Use `/preview` or the `preview_page` tool.

### Voice mode
- `ember voice` and `/voice` use local speech-to-text (whisper.cpp or faster-whisper, installed only when you ask).
- Spoken replies are optional (piper, say, espeak or SAPI).

### Editor extension and `ember serve`
- The VS Code extension (`ember-llyverse.vsix`) adds a chat panel, side-by-side diff review with Apply/Reject, and "Explain / Edit selection".
- `ember serve` exposes the agent over JSON-RPC 2.0 on stdio, so any editor can drive it.

### Ember Pro (optional, $9/mo)
- License keys are signed with Ed25519 and checked offline. Only the public key ships in the repo.
- Use `ember pro activate <key>`, `ember pro status` or `/pro`.
- Pro unlocks cloud models, team memory and premium plugins. Everything local stays free.

## v0.1.0
- First release: a local Ollama coding agent with tools, safety checks, setup/doctor, a REPL, learning memory, git checkpoints, a self-fix loop, `ember new`, explain, images, web, watch and plugins.
