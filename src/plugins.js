/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Plugin tools. A plugin is a JS module in ~/.ember/plugins/ or <project>/.ember/plugins/:
//
//   export default {
//     name: 'word_count',                       // tool name the model calls
//     description: 'Count words in a file',     // what it does (shown to the model)
//     parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
//     readOnly: true,                           // true = no approval prompt (default false: ask)
//     async run(args, ember) { ... return 'text result'; }
//   };
//
// "ember" gives plugins a small API: root, resolve(path), readFile(path), writeFile(path, text)
// (goes through the normal diff + approval), exec(command) (normal approval), print(text).
// Project plugins are code from the repo, so Ember asks you to trust each file (by hash) first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { emberHome } from './config.js';
import { isPro } from './pro.js';

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RESERVED = new Set(['list_dir', 'read_file', 'search', 'write_file', 'edit_file', 'run_command', 'update_plan', 'remember', 'web_search', 'web_fetch']);

function trustFile() { return path.join(emberHome(), 'trusted-plugins.json'); }
function loadTrust() { try { return JSON.parse(fs.readFileSync(trustFile(), 'utf8')); } catch { return {}; } }
function saveTrust(t) { fs.mkdirSync(emberHome(), { recursive: true }); fs.writeFileSync(trustFile(), JSON.stringify(t, null, 2), { mode: 0o600 }); }

export function pluginDirs(root) {
  return [
    { dir: path.join(emberHome(), 'plugins'), scope: 'global' },
    { dir: path.join(root, '.ember', 'plugins'), scope: 'project' }
  ];
}

export function validatePlugin(p) {
  if (!p || typeof p !== 'object') return 'module has no default export object';
  if (!NAME_RE.test(p.name || '')) return 'invalid or missing "name"';
  if (RESERVED.has(p.name)) return `"${p.name}" is a built-in tool name`;
  if (typeof p.description !== 'string' || !p.description) return 'missing "description"';
  if (typeof p.run !== 'function') return 'missing run(args, ember) function';
  if (p.parameters && p.parameters.type !== 'object') return '"parameters" must be a JSON schema object';
  return null;
}

/**
 * Load plugins. confirmTrust(file) is called for untrusted project plugins and must
 * resolve to true/false. Returns { tools, skipped }.
 */
export async function loadPlugins({ root, cfg = {}, confirmTrust = async () => false, log = () => {} }) {
  const tools = [], skipped = [];
  if (cfg.plugins?.enabled === false) return { tools, skipped };
  const trust = loadTrust();
  let trustChanged = false;
  for (const { dir, scope } of pluginDirs(root)) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.(m?js)$/.test(f)).sort(); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (scope === 'project' && trust[file] !== hash) {
        if (!(await confirmTrust(file))) { skipped.push({ file, reason: 'not trusted' }); continue; }
        trust[file] = hash; trustChanged = true;
      }
      let mod;
      try { mod = await import(pathToFileURL(file).href + `?v=${hash.slice(0, 8)}`); }
      catch (e) {
        // A .js plugin using "export" in a folder without {"type":"module"} is loaded as
        // CommonJS by older Node versions; retry it as an ES module copy.
        if (!(e instanceof SyntaxError) || !file.endsWith('.js')) { skipped.push({ file, reason: e.message }); continue; }
        try {
          const cache = path.join(emberHome(), 'cache', 'plugins');
          fs.mkdirSync(cache, { recursive: true });
          const copy = path.join(cache, `${path.basename(file, '.js')}-${hash.slice(0, 12)}.mjs`);
          fs.copyFileSync(file, copy);
          mod = await import(pathToFileURL(copy).href);
        } catch (e2) { skipped.push({ file, reason: e2.message }); continue; }
      }
      const p = mod.default || mod.plugin;
      const err = validatePlugin(p);
      if (err) { skipped.push({ file, reason: err }); continue; }
      if (p.pro && !isPro(cfg)) { skipped.push({ file, reason: 'premium plugin: requires Ember Pro (ember pro)' }); continue; }
      if (tools.some((t) => t.def.function.name === p.name)) { skipped.push({ file, reason: `duplicate tool ${p.name}` }); continue; }
      tools.push({
        plugin: true, file, scope,
        def: { type: 'function', function: { name: p.name, description: p.description, parameters: p.parameters || { type: 'object', properties: {} } } },
        approval: p.readOnly ? null : (a) => `Run plugin ${p.name} ${JSON.stringify(a).slice(0, 120)}?`,
        run: (ctx, args) => p.run(args, ctx.pluginApi)
      });
      log(`loaded plugin ${p.name} (${scope})`);
    }
  }
  if (trustChanged) saveTrust(trust);
  return { tools, skipped };
}
