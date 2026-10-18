<!--
  Copyright (c) 2026 LLYVerse — https://llyverse.org
  Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
-->
# Changelog

## v0.2.0 (2026-10-17)

### Faster
- Models stay loaded (`keep_alive`) and Ember warms the model up at startup.
- Prompts are trimmed and kept cache-stable, so first-call prompt tokens for `explain` dropped by 32%.
- A fast/smart model router sends small jobs (commit messages, explanations) to a fast model when you have one. On CPU, `explain` went from 17.7 s to 2.0 s.
- Big jobs run as focused steps. GPU detection is better. Run `npm run bench` to measure on your machine.

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
