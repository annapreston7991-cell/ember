/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import { banner, c } from './ui.js';
import { formatPlan, undoLast } from './tools.js';
import fs from 'node:fs';
import { saveConfig } from './config.js';
import { showMemory, showPrefs } from './memoryview.js';
import { pullWithProgress } from './setup.js';
import path from 'node:path';
import { OllamaClient } from './ollama.js';
import { findImagePaths, describeImages, DEFAULT_VISION_MODEL } from './vision.js';
import { pendingDiff, commitAll, cleanCommitMessage, isRepo } from './git.js';
import { parseModelRef } from './cloud.js';

const HELP = `
${c.bold('Commands')}
  /help              show this help
  /model [name]      show or switch the model (pulls it if needed; cloud:grok-4 for xAI)
  /models            list models installed in Ollama
  /plan              show the current plan
  /agents [on|off]   show parallel helpers (planner, coders, tester, reviewer) or turn them on/off
  /undo              revert the last file change
  /rollback          undo everything Ember changed this session (git checkpoint)
  /commit            commit all changes with an AI-written message (you approve it)
  /explain <q|file>  plain-language explanation, read-only
  /image <path> [q]  show Ember a screenshot (or just put an image path in your message)
  /fix               run the project's checks and fix failures
  /plugins           list loaded plugin tools
  /clear             start a fresh conversation
  /remember <note>   remember a preference (add --project for this repo only)
  /forget <words>    forget matching notes
  /memory            show what Ember has learned
  /prefs             show preferences, approval habits and settings
  /index [query]     rebuild the project index, or show files matching a query
  /exit              quit (Ember learns from the session first)

${c.bold('Tips')}  Describe what you want in plain words. Ember asks before every file change and command.
       Answer ${c.bold('a')} (always) to stop being asked for the rest of the session. Ctrl+C stops a running answer.
`;

/** If the prompt mentions images, let the local vision model describe them first. */
export async function withImages({ agent, ui, cfg, text, paths }) {
  const imgs = paths || findImagePaths(text, agent.root);
  if (!imgs.length) return text;
  const vmodel = cfg.visionModel || DEFAULT_VISION_MODEL;
  const local = new OllamaClient(cfg.host);
  try {
    if (!(await local.hasModel(vmodel))) {
      const ok = await ui.confirm(`Seeing images needs the vision model ${vmodel} (about 3 GB, one-time). Download it now?`, { allowAlways: false });
      if (ok !== 'y') { ui.warn('Continuing without looking at the image.'); return text; }
      await pullWithProgress(local, vmodel, ui);
    }
    ui.print(c.gray(`  · looking at ${imgs.map((p) => path.basename(p)).join(', ')} with ${vmodel}`));
    const desc = await describeImages({ client: local, model: vmodel, paths: imgs, question: text });
    return `${text}\n\n[What the attached image(s) show, described by a vision model]\n${desc}`;
  } catch (e) {
    ui.warn(`Could not read the image: ${e.message}`);
    return text;
  }
}

export async function commitFlow({ agent, ui }) {
  if (!isRepo(agent.root)) { ui.warn('This folder is not a git repository (run git init first).'); return; }
  const d = pendingDiff(agent.root);
  if (d.empty) { ui.print('Nothing to commit.'); return; }
  ui.print(c.gray(d.stat));
  ui.print(c.gray('  writing a commit message…'));
  let msg = cleanCommitMessage(await agent.commitMessage(`git status:\n${d.stat}\n\nnew files:\n${d.untracked}\n\ndiff:\n${d.diff}`));
  ui.print('\n' + c.bold(msg) + '\n');
  const a = await ui.ask(`${c.yellow('?')} Commit all changes with this message? ${c.gray('[y]es / [n]o / [e]dit')} `);
  const ans = (a || '').trim().toLowerCase();
  if (ans === 'e' || ans === 'edit') {
    const m = await ui.ask('  New summary line: ');
    if (!m || !m.trim()) { ui.print('Not committed.'); return; }
    msg = m.trim();
  } else if (ans !== 'y' && ans !== 'yes') { ui.print('Not committed.'); return; }
  try { ui.ok(`Committed ${commitAll(agent.root, msg)}: ${msg.split('\n')[0]}`); }
  catch (e) { ui.error(`git commit failed: ${e.message}`); }
}

export async function rollbackFlow({ agent, ui }) {
  const cp = agent.checkpoints;
  if (cp.enabled && cp.list.length) {
    const changes = cp.changedSince(cp.list[0].sha);
    if (!changes.length) { ui.print('Nothing has changed since the session started.'); return; }
    ui.print(c.bold('Rolling back to the start of this session would revert:'));
    ui.print(changes.map((x) => `  ${x.status === 'A' ? c.red('delete ') : x.status === 'D' ? c.green('restore') : c.yellow('revert ')} ${x.file}`).join('\n'));
    ui.print(c.gray('  (this includes edits you made yourself since then; your commits and branch are not touched)'));
    const ok = await ui.confirm('Roll back?', { allowAlways: false });
    if (ok !== 'y') return;
    cp.restore(cp.list[0].sha);
    agent.ctx.backups.length = 0;
    agent.messages.push({ role: 'user', content: '(The user rolled back all of your changes from this session.)' });
    agent.ctx.session.events.push({ type: 'rolled_back', detail: `${changes.length} files` });
    ui.ok(`Rolled back ${changes.length} file(s). Checkpoint kept at ${cp.list[0].ref}`);
    return;
  }
  if (!agent.ctx.backups.length) { ui.print('Nothing to roll back.'); return; }
  const ok = await ui.confirm(`Not a git repo: undo all ${agent.ctx.backups.length} file change(s) from this session one by one?`, { allowAlways: false });
  if (ok !== 'y') return;
  let n = 0;
  while (undoLast(agent.ctx)) n++;
  ui.ok(`Reverted ${n} change(s).`);
}

export async function runOneShot({ agent, ui, prompt }) {
  const controller = new AbortController();
  ui.onInterrupt = () => controller.abort();
  process.on('SIGINT', () => controller.abort());
  try {
    const text = await withImages({ agent, ui, cfg: agent.cfg, text: prompt });
    await agent.runTask(text, { signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) ui.warn('Stopped.');
    else throw e;
  } finally {
    if (!controller.signal.aborted) await agent.learn().catch(() => {});
  }
}

export async function runRepl({ agent, ui, cfg, client }) {
  ui.print(banner(cfg.model));
  // Load the model(s) now, while the user is typing, so the first answer starts sooner.
  for (const cl of agent.clients()) if (cl.warmup) cl.warmup(cl === agent.client ? agent.model : agent.fast?.model);
  if (agent.emberMd) ui.print(c.gray('  loaded EMBER.md project instructions'));
  if (agent.cloud) ui.print(c.yellow(`  using a cloud model: prompts and code you share go to ${agent.client.label}`));
  const plugins = agent.extraTools.filter((t) => t.plugin);
  if (plugins.length) ui.print(c.gray(`  plugins: ${plugins.map((t) => t.def.function.name).join(', ')}`));
  if (cfg.web?.enabled) ui.print(c.gray('  web lookup is on (web_search, web_fetch ask before each use)'));
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
        case '/agents': {
          const { formatTeam } = await import('./team.js');
          if (rest === 'on' || rest === 'off') { cfg.team = { ...(cfg.team || {}), enabled: rest === 'on' }; ui.ok(`Parallel helpers ${rest} for this session`); }
          ui.print(formatTeam(agent.team, { enabled: cfg.team?.enabled !== false, maxParallel: cfg.team?.maxParallel ?? 2 }));
          continue;
        }
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
          const before = cfg.model;
          if (!rest) { ui.print(`Current model: ${c.bold(cfg.model)}${agent.cloud ? c.yellow(' (cloud)') : c.gray(' (local)')}  (switch with /model qwen2.5-coder:14b or /model cloud:grok-4)`); continue; }
          try {
            if (parseModelRef(rest, cfg)) {
              const r = agent.setModel(rest);
              if (!(await r.client.hasModel())) {
                ui.error(`No API key found for ${r.client.label}. Set ${r.client.p.apiKeyEnv || 'an apiKey'} (e.g. export ${r.client.p.apiKeyEnv}=...) and try again.`);
                agent.setModel(before); continue;
              }
              if (!parseModelRef(before, cfg)) cfg.lastLocalModel = before;
              ui.warn(`Cloud model: your prompts and the code Ember reads will be sent to ${r.client.label}. Use /model ${prevModel(cfg)} to go back to local.`);
            } else {
              const local = new OllamaClient(cfg.host);
              if (!(await local.hasModel(rest))) {
                const ok = await ui.confirm(`${rest} is not downloaded. Pull it now?`, { allowAlways: false });
                if (ok !== 'y') continue;
                await pullWithProgress(local, rest, ui);
              }
              agent.setModel(rest);
              cfg.lastLocalModel = rest;
            }
            saveConfig(cfg);
            await agent.init();
            ui.ok(`Now using ${rest}${agent.native ? '' : ' (JSON tool mode)'}`);
          } catch (e) { ui.error(e.message); }
          continue;
        }
        case '/rollback': try { await rollbackFlow({ agent, ui }); } catch (e) { ui.error(e.message); } continue;
        case '/commit': try { await commitFlow({ agent, ui }); } catch (e) { ui.error(e.message); } continue;
        case '/plugins': {
          const pl = agent.extraTools.filter((t) => t.plugin);
          ui.print(pl.length ? pl.map((t) => `  ${c.bold(t.def.function.name)} ${c.gray(`(${t.scope}) ${t.def.function.description}`)}`).join('\n') : c.gray('  no plugins loaded (put .js files in ~/.ember/plugins or .ember/plugins)'));
          if (cfg.web?.enabled) ui.print(c.gray('  web_search, web_fetch enabled'));
          continue;
        }
        case '/fix': {
          controller = new AbortController();
          try { await agent.selfFix({ signal: controller.signal }); } catch (e) { if (!controller.signal.aborted) ui.error(e.message); } finally { controller = null; }
          continue;
        }
        case '/explain': {
          if (!rest) { ui.print('Usage: /explain <question or file>'); continue; }
          controller = new AbortController();
          try { ui.print(''); await agent.explain(explainPrompt(rest, agent.root), { signal: controller.signal }); ui.print(''); }
          catch (e) { if (controller.signal.aborted) ui.warn('Stopped.'); else ui.error(e.message); }
          finally { controller = null; }
          continue;
        }
        case '/image': {
          const [imgPath, ...q] = restArr;
          if (!imgPath) { ui.print('Usage: /image <path> [what to do]'); continue; }
          const abs = path.resolve(agent.root, imgPath.replace(/^~(?=\/)/, process.env.HOME || '~'));
          const question = q.join(' ') || 'Look at this screenshot and tell me what you see and what might be wrong.';
          controller = new AbortController();
          try {
            const text = await withImages({ agent, ui, cfg, text: question, paths: [abs] });
            ui.print('');
            await agent.runTask(text, { signal: controller.signal });
            ui.print('');
          } catch (e) { if (controller.signal.aborted) ui.warn('Stopped.'); else ui.error(e.message); }
          finally { controller = null; }
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
        case '/index': {
          try {
            if (rest) { const { formatHits } = await import('./indexer.js'); ui.print(formatHits(await agent.findCode(rest, 8), 2000) || 'No matches (is the index built? run /index).'); }
            else { const st = await agent.initIndex({ force: true }); ui.ok(st ? `Index: ${st.files} files, ${st.symbols} symbols, ${st.changed} updated${st.embedded ? `, ${st.embedded} chunks embedded` : ''} (${(st.ms / 1000).toFixed(1)}s)` : `Index unavailable${agent.indexError ? `: ${agent.indexError}` : ''}`); }
          } catch (e) { ui.warn(e.message); }
          continue;
        }
        case '/prefs': showPrefs(ui, agent.memory, cfg); continue;
        default: ui.warn(`Unknown command ${cmd}. Type /help.`); continue;
      }
    }

    controller = new AbortController();
    try {
      ui.print('');
      const text = await withImages({ agent, ui, cfg, text: input });
      await agent.runTask(text, { signal: controller.signal });
      ui.print('');
    } catch (e) {
      if (controller.signal.aborted) ui.warn('Stopped.');
      else ui.error(e.message);
    } finally {
      controller = null;
    }
  }
}

function prevModel(cfg) { return cfg.lastLocalModel || 'qwen2.5-coder:7b'; }

/** "/explain src/app.js" reads like "Explain src/app.js"; anything else is a question. */
export function explainPrompt(arg, root) {
  const p = path.resolve(root, arg.trim());
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    // Include the file so even small models explain the real code instead of guessing.
    const rel = path.relative(root, p);
    let body = '';
    try { body = fs.readFileSync(p, 'utf8'); } catch { /* unreadable */ }
    const shown = body.length > 12000 ? body.slice(0, 12000) + '\n… (truncated; use read_file for the rest)' : body;
    return `Explain the file ${rel} in plain language: what it does, how it works, and anything that looks wrong.\n\nHere is ${rel}:\n\`\`\`\n${shown}\n\`\`\``;
  }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return `Explain what the code in ${path.relative(root, p) || 'this project'} does, in plain language. Look around first.`;
  return arg;
}
