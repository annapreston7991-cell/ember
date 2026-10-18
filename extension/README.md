# Ember for VS Code

Chat with **Ember**, a local AI coding agent that runs on [Ollama](https://ollama.com), right inside VS Code.

- **Chat panel:** open the 🔥 Ember icon in the activity bar. Ask it to build, fix, or explain something.
- **Apply diffs:** every change Ember proposes opens in VS Code's diff editor. Choose **Apply**, **Apply All**, or **Reject**. When you reject, you can say what to change instead.
- **Explain selection:** select code, right-click, and pick **Ember: Explain Selection** (`Ctrl+Alt+E` / `Cmd+Alt+E`). It is read-only.
- **Edit selection:** right-click and pick **Ember: Edit Selection…**, then describe the change.
- **Commands ask first:** Ember asks in a dialog before running a command. Destructive commands need you to type `yes`.
- **Undo / Stop / New chat:** these buttons are in the panel and in the command palette.

Everything runs on your machine. The extension starts `ember serve` (JSON-RPC over stdio) in your workspace folder, and the Ember CLI does the rest, using your normal `~/.ember` config, memory and project index.

## Requirements

Install the Ember CLI and run setup once:

```bash
git clone https://github.com/annapreston7991-cell/ember.git ~/ember && ~/ember/install.sh
ember setup
```

If `ember` isn't on VS Code's PATH, set **Settings › Ember › Path** to the full path (for example `~/.npm-global/bin/ember`).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `ember.path` | `ember` | the Ember CLI to run |
| `ember.model` | (empty) | model override, e.g. `qwen2.5-coder:7b` |
| `ember.autoApprove` | `false` | apply changes and run allowlisted or approved commands without asking (like `--yes`). Destructive commands always ask |

## License

LLYVerse License 1.0. Ember is part of the LLYVerse — https://llyverse.org
