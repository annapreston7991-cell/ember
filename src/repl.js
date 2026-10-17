/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import { banner, c } from './ui.js';
import { formatPlan, undoLast } from './tools.js';
import { saveConfig } from './config.js';
import { showMemory, showPrefs } from './memoryview.js';
import { pullWithProgress } from './setup.js';

const HELP = `
${c.bold('Commands')}
  /help              show this help
  /model [name]      show or switch the model (pulls it if needed)
  /models            list models installed in Ollama
  /plan              show the current plan
  /undo              revert the last file change
  /clear             start a fresh conversation
  /remember <note>   remember a preference (add --project for this repo only)
  /forget <words>    forget matching notes
  /memory            show what Ember has learned
  /prefs             show preferences, approval habits and settings
  /exit              quit (Ember learns from the session first)

${c.bold('Tips')}  Describe what you want in plain words. Ember asks before every file change and command.
       Answer ${c.bold('a')} (always) to stop being asked for the rest of the session. Ctrl+C stops a running answer.
`;

export async function runOneShot({ agent, ui, prompt }) {
  const controller = new AbortController();
  ui.onInterrupt = () => controller.abort();
  process.on('SIGINT', () => controller.abort());
  try {
    await agent.run(prompt, { signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) ui.warn('Stopped.');
    else throw e;
  } finally {
    if (!controller.signal.aborted) await agent.learn().catch(() => {});
  }
}

export async function runRepl({ agent, ui, cfg, client }) {
  ui.print(banner(cfg.model));
  if (agent.emberMd) ui.print(c.gray('  loaded EMBER.md project instructions'));
  if (agent.memory?.enabled) {
    const n = agent.memory.profile.notes.length + agent.memory.project.length;
    if (n) ui.print(c.gray(`  remembering ${n} note(s) about you and this project · /memory to see them`));
  }
  ui.print('');

  let controller = null;
  let exitArmed = false;
  ui.onInterrupt = () => {
    if (controller) { controller.abort(); return; }
    if (exitArmed) { ui.print(''); process.exit(0); }
    exitArmed = true;
    ui.print(c.gray('\n(press Ctrl+C again, or type /exit, to quit)'));
  };

  const finish = async () => {
    if (agent.memory?.enabled && cfg.memory?.autoLearn !== false && agent.ctx.session.events.length + agent.ctx.session.said.length > 0) {
      ui.print(c.gray('learning from this session…'));
      const learned = await agent.learn().catch(() => []);
      for (const l of learned) ui.print(c.gray(`  + ${l}`));
    }
    ui.print(c.gray('bye 🔥'));
  };

  for (;;) {
    const line = await ui.ask(c.bold().red('ember') + c.gray(' › '));
    if (line === null) { await finish(); return; }
    exitArmed = false;
    const input = line.trim();
    if (!input) continue;

    if (input.startsWith('/')) {
      const [cmd, ...restArr] = input.split(/\s+/);
      const rest = restArr.join(' ');
      switch (cmd) {
        case '/help': case '/?': ui.print(HELP); continue;
        case '/exit': case '/quit': case '/q': await finish(); return;
        case '/clear': agent.clear(); ui.ok('Conversation cleared.'); continue;
        case '/plan': ui.print(formatPlan(agent.ctx.plan)); continue;
        case '/undo': {
          const r = undoLast(agent.ctx);
          if (!r) ui.print('Nothing to undo.');
          else {
            ui.ok(r.deleted ? `Removed new file ${r.path}` : `Restored ${r.path}`);
            agent.messages.push({ role: 'user', content: `(The user undid your last change to ${r.path}.)` });
            agent.ctx.session.events.push({ type: 'undone', detail: r.path });
          }
          continue;
        }
        case '/models': {
          try {
            const ms = await client.listModels();
            ui.print(ms.length ? ms.map((m) => `  ${m.name === cfg.model ? c.green('●') : ' '} ${m.name} ${c.gray((m.size / 1e9).toFixed(1) + ' GB')}`).join('\n') : 'No models installed.');
          } catch (e) { ui.error(e.message); }
          continue;
        }
        case '/model': {
          if (!rest) { ui.print(`Current model: ${c.bold(cfg.model)}  (switch with /model qwen2.5-coder:14b)`); continue; }
          try {
            if (!(await client.hasModel(rest))) {
              const ok = await ui.confirm(`${rest} is not downloaded. Pull it now?`, { allowAlways: false });
              if (ok !== 'y') continue;
              await pullWithProgress(client, rest, ui);
            }
            cfg.model = rest;
            saveConfig(cfg);
            await agent.init();
            ui.ok(`Now using ${rest}${agent.native ? '' : ' (JSON tool mode)'}`);
          } catch (e) { ui.error(e.message); }
          continue;
        }
        case '/remember': {
          if (!agent.memory?.enabled) { ui.warn('Memory is off (ember memory on).'); continue; }
          const project = /(^|\s)--project\b/.test(rest);
          const text = rest.replace(/(^|\s)--(project|global)\b/g, ' ').trim();
          if (!text) { ui.print('Usage: /remember [--project] <note>'); continue; }
          const r = agent.memory.remember(text, { scope: project ? 'project' : 'global', source: 'explicit' });
          ui.ok(`Remembered${project ? ' for this project' : ''}: ${text}`);
          if (r.replaced?.length) ui.print(c.gray(`  replaces: ${r.replaced.map((x) => x.text).join('; ')}`));
          continue;
        }
        case '/forget': {
          if (!rest) { ui.print('Usage: /forget <id or words>'); continue; }
          const removed = agent.memory?.forget(rest) || [];
          ui.print(removed.length ? removed.map((n) => c.red('  - ') + n.text).join('\n') : 'No matching notes.');
          continue;
        }
        case '/memory': showMemory(ui, agent.memory); continue;
        case '/prefs': showPrefs(ui, agent.memory, cfg); continue;
        default: ui.warn(`Unknown command ${cmd}. Type /help.`); continue;
      }
    }

    controller = new AbortController();
    try {
      ui.print('');
      await agent.run(input, { signal: controller.signal });
      ui.print('');
    } catch (e) {
      if (controller.signal.aborted) ui.warn('Stopped.');
      else ui.error(e.message);
    } finally {
      controller = null;
    }
  }
}
