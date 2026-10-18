/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { emberHome } from './config.js';
import { packageManager } from './checks.js';
import { isAllowlisted } from './safety.js';
import { c } from './ui.js';

/** Where optional tools Ember installs on demand live (never inside your project). */
export const toolsDir = () => path.join(emberHome(), 'tools');

const PORT_GUESS = [[/\bvite\b/, 5173], [/\bnext\b/, 3000], [/\bastro\b/, 4321], [/react-scripts/, 3000], [/\bnuxt\b/, 3000], [/svelte-kit|sveltekit/, 5173], [/\bremix\b/, 3000], [/\bparcel\b/, 1234], [/webpack(-dev)?-server|webpack serve/, 8080], [/\bng serve\b/, 4200]];

/**
 * How to run this project's dev server: a package.json script (dev/start/serve/preview),
 * Django / plain Python, or Ember's built-in static server for a folder with index.html.
 */
export function detectDevServer(root, cfg = {}) {
  if (cfg.preview?.command) return { kind: 'custom', command: cfg.preview.command, port: cfg.preview.port || null };
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* ignore */ }
    const scripts = pkg.scripts || {};
    const name = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s]);
    if (name) {
      const pm = packageManager(root);
      const script = scripts[name];
      const guess = PORT_GUESS.find(([re]) => re.test(script));
      const m = script.match(/(?:--port[ =]|-p\s+|PORT=)(\d{2,5})/);
      return { kind: 'script', command: `${pm} run ${name}`, script, port: m ? +m[1] : guess ? guess[1] : 3000 };
    }
  }
  if (fs.existsSync(path.join(root, 'manage.py'))) return { kind: 'django', command: 'python3 manage.py runserver 8000', port: 8000 };
  for (const dir of ['', 'public', 'dist', 'build', 'site', 'docs']) {
    if (fs.existsSync(path.join(root, dir, 'index.html'))) return { kind: 'static', dir: path.join(root, dir), command: null, port: null };
  }
  return null;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };

/** A tiny static file server bound to 127.0.0.1 (path-jailed to dir). */
export async function staticServer(dir, port) {
  const root = fs.realpathSync(dir);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let abs = path.join(root, p);
    try { if (fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html'); } catch { /* 404 below */ }
    let real;
    try { real = fs.realpathSync(abs); } catch { res.statusCode = 404; return res.end('Not found'); }
    if (real !== root && !real.startsWith(root + path.sep)) { res.statusCode = 403; return res.end('Forbidden'); }
    res.setHeader('content-type', TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(real).pipe(res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

/** Wait until url answers (any HTTP status). */
export async function waitForUrl(url, timeoutMs = 45000, isAlive = () => true) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!isAlive()) return false;
    try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"\x1b]*/;

/**
 * Start (with approval) the dev server. Returns { url, stop(), log(), command }.
 * Commands are asked about like any other command unless allowlisted; --yes approves.
 */
export async function startPreview({ root, ui, cfg, ctx, timeoutMs = 45000 }) {
  const d = detectDevServer(root, cfg);
  if (!d) throw new Error('No dev server found. Add a "dev" or "start" script to package.json, an index.html, or set "preview": { "command": "...", "port": 3000 } in ~/.ember/config.json.');
  if (d.kind === 'static') {
    const port = await freePort();
    const server = await staticServer(d.dir, port);
    const url = `http://127.0.0.1:${port}/`;
    ui.print(c.gray(`  · serving ${path.relative(root, d.dir) || '.'} at ${url}`));
    return { url, command: null, stop: () => new Promise((r) => server.close(r)), log: () => '' };
  }
  const allowed = isAllowlisted(d.command, cfg.allowlist || []) || ctx?.always?.commands?.has(d.command);
  if (!allowed) {
    const ok = await ui.confirm(`Start the dev server with "${d.command}"?`);
    if (ok === 'a') ctx?.always?.commands?.add(d.command);
    if (ok !== 'y' && ok !== 'a') throw new Error('Dev server not started.');
  }
  const env = { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', CI: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(d.command, { cwd: root, shell: true, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let found = null;
  const onData = (b) => { out = (out + b.toString()).slice(-20000); const m = out.replace(/\x1b\[[0-9;]*m/g, '').match(URL_RE); if (m && !found) found = m[0].replace('0.0.0.0', '127.0.0.1').replace(/[.,)]+$/, ''); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  let alive = true;
  child.on('exit', () => { alive = false; });
  ui.print(c.gray(`  · started: ${d.command} (pid ${child.pid})`));
  const stop = () => new Promise((resolve) => {
    if (!alive) return resolve();
    child.once('exit', () => resolve());
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } resolve(); }, 3000).unref();
  });
  // Wait for a URL in the output, else probe the guessed port.
  const end = Date.now() + timeoutMs;
  while (!found && alive && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 300));
    if (!found && d.port) { try { await fetch(`http://127.0.0.1:${d.port}/`, { signal: AbortSignal.timeout(800) }); found = `http://127.0.0.1:${d.port}/`; } catch { /* not yet */ } }
  }
  if (!found || !(await waitForUrl(found.replace('localhost', '127.0.0.1'), Math.max(2000, end - Date.now()), () => alive))) {
    await stop();
    throw new Error(`The dev server did not come up${alive ? ` within ${Math.round(timeoutMs / 1000)}s` : ''}. Last output:\n${out.slice(-1500)}`);
  }
  return { url: found, command: d.command, stop, log: () => out, pid: child.pid };
}

// ---------- screenshots ----------

const CHROMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
const MAC_CHROMES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];

export function findChrome() {
  if (process.env.EMBER_CHROME && fs.existsSync(process.env.EMBER_CHROME)) return process.env.EMBER_CHROME;
  for (const p of MAC_CHROMES) if (fs.existsSync(p)) return p;
  for (const b of CHROMES) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [b], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n')[0];
  }
  return null;
}

/** Load an optional npm package from the project or from ~/.ember/tools. */
export async function loadOptional(name, root) {
  for (const base of [root, toolsDir()].filter(Boolean)) {
    try {
      const req = createRequire(path.join(base, 'noop.js'));
      const p = req.resolve(name);
      const mod = await import(pathToFileURL(p).href);
      return mod.default || mod;
    } catch { /* try next */ }
  }
  return null;
}

/** Which screenshot engine is available: 'playwright' | 'puppeteer' | 'chrome' | null. */
export async function screenshotEngine(root) {
  const chrome = findChrome();
  const hasOwn = (m) => { try { return fs.existsSync(m.chromium?.executablePath?.() || m.executablePath?.() || ''); } catch { return false; } };
  for (const n of ['playwright', 'playwright-core']) { const m = await loadOptional(n, root); if (m?.chromium && (hasOwn(m) || chrome)) return { kind: 'playwright', mod: m }; }
  const pp = await loadOptional('puppeteer', root) || await loadOptional('puppeteer-core', root);
  if (pp?.launch && (hasOwn(pp) || chrome)) return { kind: 'puppeteer', mod: pp };
  if (chrome) return { kind: 'chrome', bin: chrome };
  return null;
}

/** Install playwright + Chromium into ~/.ember/tools, after asking. */
export async function installScreenshotTools({ ui }) {
  const dir = toolsDir();
  const ok = await ui.confirm(`Screenshots need a headless browser. Install Playwright + Chromium (~150 MB) into ${dir}?`, { allowAlways: false });
  if (ok !== 'y') return false;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ember-tools', private: true }, null, 2));
  for (const [cmd, args] of [['npm', ['install', '--no-audit', '--no-fund', 'playwright']], ['npx', ['playwright', 'install', 'chromium']]]) {
    ui.print(c.gray(`  $ ${cmd} ${args.join(' ')}`));
    const r = spawnSync(cmd, args, { cwd: dir, stdio: 'inherit' });
    if (r.status !== 0) { ui.warn(`${cmd} ${args.join(' ')} failed.`); return false; }
  }
  return true;
}

/**
 * Take a screenshot of url into outPath. Returns { path, engine, console: [..errors], title }.
 * Console errors and page errors are collected when the engine supports it.
 */
export async function screenshot(url, outPath, { root, width = 1280, height = 800, engine, waitMs = 1500 } = {}) {
  const eng = engine || await screenshotEngine(root);
  if (!eng) throw new Error('NO_ENGINE');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const errors = [];
  if (eng.kind === 'playwright' || eng.kind === 'puppeteer') {
    const chrome = findChrome();
    const browser = eng.kind === 'playwright'
      ? await eng.mod.chromium.launch({ headless: true }).catch(async (e) => { if (chrome) return eng.mod.chromium.launch({ headless: true, executablePath: chrome }); throw e; })
      : await eng.mod.launch({ headless: true, ...(chrome && !eng.mod.executablePath?.() ? { executablePath: chrome } : {}) });
    try {
      const page = await browser.newPage();
      if (page.setViewportSize) await page.setViewportSize({ width, height }); else await page.setViewport({ width, height });
      page.on('console', (m) => { const t = typeof m.type === 'function' ? m.type() : m.type; if (t === 'error') errors.push(`console.error: ${m.text()}`); });
      page.on('pageerror', (e) => errors.push(`page error: ${e.message || e}`));
      page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
      await page.goto(url, { waitUntil: eng.kind === 'playwright' ? 'networkidle' : 'networkidle2', timeout: 30000 }).catch((e) => errors.push(`navigation: ${e.message.split('\n')[0]}`));
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 3000)));
      const title = await page.title().catch(() => '');
      await page.screenshot({ path: outPath, fullPage: false });
      return { path: outPath, engine: eng.kind, console: errors, title };
    } finally { await browser.close().catch(() => {}); }
  }
  // System Chrome / Chromium CLI: no install needed. Console messages come from Chrome's stderr log.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-chrome-'));
  try {
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--no-sandbox',
      `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--virtual-time-budget=${Math.max(1000, waitMs + 1500)}`,
      '--enable-logging=stderr', '--v=0', `--screenshot=${outPath}`, url];
    const r = await new Promise((resolve) => {
      const ch = spawn(eng.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      ch.stderr.on('data', (b) => { err += b; });
      const t = setTimeout(() => ch.kill('SIGKILL'), 45000);
      ch.on('exit', (code) => { clearTimeout(t); resolve({ code, err }); });
      ch.on('error', (e) => { clearTimeout(t); resolve({ code: -1, err: e.message }); });
    });
    for (const m of r.err.matchAll(/(\w+):CONSOLE(?:\(\d+\)|:\d+)?\]\s*"(.*?)", source: (\S*) \((\d+)\)/g)) {
      if (m[1] === 'ERROR' || /error|uncaught|failed|cannot|undefined|not defined|exception/i.test(m[2])) errors.push(`console: ${m[2]} (${path.basename(m[3]) || 'page'}:${m[4]})`);
    }
    if (!fs.existsSync(outPath)) throw new Error(`Chrome could not take the screenshot (exit ${r.code}). ${r.err.split('\n').slice(-3).join(' ')}`);
    return { path: outPath, engine: 'chrome', console: errors, title: '' };
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}

/** Folder for preview screenshots (inside .ember/, kept out of git). */
export function shotPath(root) {
  const dir = path.join(root, '.ember', 'cache', 'preview');
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(root, '.ember', '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'index/\ncache/\n');
  return path.join(dir, `shot-${Date.now()}.png`);
}

export function joinUrl(base, p) {
  if (!p) return base;
  if (/^https?:\/\//.test(p)) return p;
  return new URL(p.replace(/^\/?/, '/'), base).href;
}

/** Text the model gets after a preview. */
export function previewReport({ url, shot, description, title }) {
  const errs = shot.console.length ? `Browser errors:\n${shot.console.slice(0, 15).map((e) => `- ${e}`).join('\n')}` : 'Browser errors: none seen.';
  return `[Live preview of ${url}${title ? ` — "${title}"` : ''}, screenshot ${shot.path} via ${shot.engine}]\n${description ? `What the page shows (vision model):\n${description}\n` : ''}${errs}`;
}

/**
 * One preview pass: start the dev server if needed (with approval), take a screenshot,
 * let the local vision model describe it, and collect browser errors. Returns { report, shot, description }.
 */
export async function previewOnce({ agent, ui, cfg, target = '', question = '', signal, describe, ensureVision }) {
  let base;
  if (/^https?:\/\//.test(target)) base = target;
  else {
    if (!agent.preview) {
      agent.preview = await startPreview({ root: agent.root, ui, cfg, ctx: agent.ctx });
      registerPreviewTool(agent, { ui, cfg, describe, ensureVision });
    }
    base = joinUrl(agent.preview.url, target);
  }
  let engine = await screenshotEngine(agent.root);
  if (!engine && await installScreenshotTools({ ui })) engine = await screenshotEngine(agent.root);
  if (!engine) {
    const r = await fetch(base, { signal: AbortSignal.timeout(10000) }).then(async (x) => `HTTP ${x.status}, ${(await x.text()).length} bytes`).catch((e) => e.message);
    ui.warn('No headless browser available, so there is no screenshot. Install Chrome/Chromium, or run /preview again and accept the Playwright install.');
    return { report: `[Live preview of ${base}: no screenshot (no headless browser). Fetch result: ${r}]`, shot: null, description: '' };
  }
  ui.print(c.gray(`  · screenshot of ${base} (${engine.kind})`));
  const shot = await screenshot(base, shotPath(agent.root), { root: agent.root, engine, width: cfg.preview?.width || 1280, height: cfg.preview?.height || 800 });
  let description = '';
  if (describe && (!ensureVision || await ensureVision())) {
    ui.print(c.gray(`  · looking at it with ${cfg.visionModel}`));
    try { description = await describe(shot.path, question || 'This is a screenshot of the web app being developed. Describe the page and anything that looks broken.', signal); }
    catch (e) { ui.warn(`Vision model failed: ${e.message}`); }
  }
  return { report: previewReport({ url: base, shot, description, title: shot.title }), shot, description };
}

/** While a preview is running, the agent can re-check the page itself after edits. */
export function registerPreviewTool(agent, { ui, cfg, describe, ensureVision }) {
  if (agent.extraTools.some((t) => t.def.function.name === 'preview_page')) return;
  agent.extraTools.push({
    def: { type: 'function', function: { name: 'preview_page', description: 'Screenshot the running dev server page and describe it (vision) with browser errors. Use after UI changes.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'e.g. / or /about' }, question: { type: 'string' } } } } },
    approval: null,
    run: async (_ctx, a) => (await previewOnce({ agent, ui: agent.ui, cfg, target: String(a.path || ''), question: String(a.question || ''), describe, ensureVision })).report
  });
}

export async function stopPreview(agent) {
  if (!agent.preview) return false;
  await agent.preview.stop();
  agent.preview = null;
  agent.extraTools = agent.extraTools.filter((t) => t.def.function.name !== 'preview_page');
  return true;
}
