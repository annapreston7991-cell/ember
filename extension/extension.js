/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
'use strict';
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { EmberClient } = require('./rpc');

const SCHEME = 'ember-proposed';

/** Holds proposed file contents so VS Code's diff editor can show them. */
class ProposedContent {
  constructor() { this.docs = new Map(); this.emitter = new vscode.EventEmitter(); this.onDidChange = this.emitter.event; }
  set(uri, text) { this.docs.set(uri.toString(), text); this.emitter.fire(uri); }
  provideTextDocumentContent(uri) { return this.docs.get(uri.toString()) ?? ''; }
}

class EmberSession {
  constructor(context) {
    this.context = context;
    this.client = null;
    this.view = null;
    this.busy = false;
    this.alwaysApply = false;
    this.proposed = new ProposedContent();
    this.output = vscode.window.createOutputChannel('Ember');
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.proposed), this.output);
  }

  root() {
    const ed = vscode.window.activeTextEditor;
    const ws = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
    return ws ? ws.uri.fsPath : (ed ? path.dirname(ed.document.uri.fsPath) : process.cwd());
  }

  post(msg) { if (this.view) this.view.webview.postMessage(msg); }

  async ensure() {
    if (this.client && this.client.proc) return this.client;
    const cfg = vscode.workspace.getConfiguration('ember');
    const args = ['serve', '-C', this.root()];
    if (cfg.get('model')) args.push('--model', cfg.get('model'));
    if (cfg.get('autoApprove')) args.push('--yes');
    const client = new EmberClient({ command: cfg.get('path') || 'ember', args, cwd: this.root() });
    client.on('stream', (p) => this.post({ type: 'stream', text: p.text }));
    client.on('output', (p) => { this.output.appendLine(p.text); this.post({ type: 'output', text: p.text }); });
    client.on('busy', (p) => { this.busy = p.busy; this.post({ type: 'busy', busy: p.busy }); });
    client.on('plan', (p) => this.post({ type: 'plan', text: p.text }));
    client.on('stderr', (t) => this.output.append(t));
    client.on('error', (e) => this.fail(e));
    client.on('exit', ({ code }) => { this.post({ type: 'busy', busy: false }); if (code) this.post({ type: 'error', text: `ember serve stopped (exit ${code}). See Output › Ember.` }); });
    client.onRequest('approval', (p) => this.approve(p));
    client.onRequest('input', async (p) => ({ text: (await vscode.window.showInputBox({ prompt: p.prompt || 'Ember asks', ignoreFocusOut: true })) || '' }));
    client.start();
    this.client = client;
    try {
      const info = await client.request('initialize', { root: this.root() });
      this.post({ type: 'info', text: `Ember ${info.version} · ${info.model} · ${path.basename(info.root)}` });
      if (!info.ready) this.post({ type: 'error', text: info.problem });
    } catch (e) { this.fail(e); throw e; }
    return client;
  }

  fail(e) {
    const msg = /ENOENT|not found|spawn/i.test(String(e && e.message))
      ? 'Could not start the ember CLI. Install it (see the Ember README), or set "ember.path" in Settings.'
      : String(e && e.message || e);
    this.post({ type: 'error', text: msg });
    vscode.window.showErrorMessage(`Ember: ${msg}`);
    this.client = null;
  }

  /** Approvals from the agent: diffs open in VS Code's diff editor; commands ask in a modal. */
  async approve(p) {
    if (p.kind === 'change') {
      if (this.alwaysApply) return { answer: 'y' };
      const root = this.root();
      const abs = path.join(root, p.path);
      const right = vscode.Uri.from({ scheme: SCHEME, path: '/' + p.path, query: crypto.randomUUID() });
      this.proposed.set(right, p.after);
      let left;
      if (p.before === null) { left = vscode.Uri.from({ scheme: SCHEME, path: '/' + p.path, query: 'empty-' + crypto.randomUUID() }); this.proposed.set(left, ''); }
      else left = vscode.Uri.file(abs);
      const title = `Ember: ${p.label} ${p.path} (+${p.stats?.add ?? 0} −${p.stats?.del ?? 0})`;
      await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
      this.post({ type: 'change', path: p.path, label: p.label, stats: p.stats });
      const pick = await vscode.window.showInformationMessage(`${p.label} ${p.path}?`, 'Apply', 'Apply All', 'Reject');
      if (pick === 'Apply All') { this.alwaysApply = true; return { answer: 'a' }; }
      if (pick === 'Apply') return { answer: 'y' };
      const feedback = await vscode.window.showInputBox({ prompt: `Why not? What should change in ${p.path}? (optional)`, ignoreFocusOut: true });
      return { answer: 'n', feedback };
    }
    if (p.kind === 'danger') {
      const pick = await vscode.window.showWarningMessage(`DANGER: ${p.question}`, { modal: true }, 'Run anyway…');
      if (pick !== 'Run anyway…') return { answer: 'no' };
      const typed = await vscode.window.showInputBox({ prompt: 'Type "yes" to run this destructive command', ignoreFocusOut: true });
      return { answer: typed === 'yes' ? 'yes' : 'no' };
    }
    const buttons = p.allowAlways === false ? ['Yes'] : ['Yes', 'Always'];
    const pick = await vscode.window.showWarningMessage(p.question, { modal: true }, ...buttons);
    return { answer: pick === 'Always' ? 'a' : pick === 'Yes' ? 'y' : 'n' };
  }

  async send(text, { mode = 'agent', label } = {}) {
    await this.reveal();
    this.post({ type: 'user', text: label || text });
    try {
      const client = await this.ensure();
      const r = await client.request('chat', { text, mode });
      this.post({ type: 'done', text: r.text });
    } catch (e) { this.post({ type: 'error', text: e.message }); }
  }

  async explainSelection() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return vscode.window.showInformationMessage('Open a file first.');
    const sel = ed.selection;
    const text = ed.document.getText(sel.isEmpty ? undefined : sel);
    const file = vscode.workspace.asRelativePath(ed.document.uri, false);
    await this.reveal();
    this.post({ type: 'user', text: `Explain ${file}${sel.isEmpty ? '' : `:${sel.start.line + 1}-${sel.end.line + 1}`}` });
    try {
      const client = await this.ensure();
      const r = await client.request('explain', { file, selection: text, language: ed.document.languageId, startLine: sel.start.line + 1 });
      this.post({ type: 'done', text: r.text });
    } catch (e) { this.post({ type: 'error', text: e.message }); }
  }

  async editSelection() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const instruction = await vscode.window.showInputBox({ prompt: 'What should Ember change in the selection?', placeHolder: 'e.g. add input validation and a JSDoc comment' });
    if (!instruction) return;
    const sel = ed.selection;
    const file = vscode.workspace.asRelativePath(ed.document.uri, false);
    if (ed.document.isDirty) await ed.document.save();
    const code = ed.document.getText(sel);
    const text = `${instruction}\nOnly change this part of ${file} (lines ${sel.start.line + 1}-${sel.end.line + 1}) unless more is truly needed:\n\`\`\`${ed.document.languageId}\n${code}\n\`\`\`\nUse edit_file on ${file}.`;
    await this.send(text, { label: `${instruction} (${file}:${sel.start.line + 1}-${sel.end.line + 1})` });
  }

  async reveal() { if (!this.view) await vscode.commands.executeCommand('ember.chat.focus'); else this.view.show?.(true); }

  async request(method) {
    if (!this.client) return null;
    try { return await this.client.request(method); } catch (e) { this.post({ type: 'error', text: e.message }); return null; }
  }

  async dispose() { if (this.client) await this.client.stop(); this.client = null; }
}

class ChatView {
  constructor(session, extUri) { this.session = session; this.extUri = extUri; }
  resolveWebviewView(view) {
    this.session.view = view;
    const media = vscode.Uri.joinPath(this.extUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('hex');
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<div id="log"><div class="hint">Ask Ember to build, fix or explain something. Changes open as diffs for you to apply. Runs locally on Ollama.</div></div>
<form id="f"><textarea id="q" rows="3" placeholder="Ask Ember… (Enter to send, Shift+Enter for a new line)"></textarea>
<div class="row"><button type="submit" id="send">Send</button><button type="button" id="stop" disabled>Stop</button><button type="button" id="undo">Undo</button><button type="button" id="new">New chat</button></div></form>
<div class="foot">Ember is part of the LLYVerse</div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'send') return this.session.send(m.text);
      if (m.type === 'stop') return this.session.request('cancel');
      if (m.type === 'new') { this.session.alwaysApply = false; await this.session.request('reset'); return this.session.post({ type: 'cleared' }); }
      if (m.type === 'undo') { const r = await this.session.request('undo'); if (r) this.session.post({ type: 'output', text: r.text }); }
    });
    view.onDidDispose(() => { this.session.view = null; });
  }
}

function activate(context) {
  const session = new EmberSession(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ember.chat', new ChatView(session, context.extensionUri), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('ember.explainSelection', () => session.explainSelection()),
    vscode.commands.registerCommand('ember.editSelection', () => session.editSelection()),
    vscode.commands.registerCommand('ember.ask', async () => { const q = await vscode.window.showInputBox({ prompt: 'Ask Ember' }); if (q) await session.send(q); }),
    vscode.commands.registerCommand('ember.newChat', async () => { session.alwaysApply = false; await session.request('reset'); session.post({ type: 'cleared' }); }),
    vscode.commands.registerCommand('ember.stop', () => session.request('cancel')),
    vscode.commands.registerCommand('ember.undo', async () => { const r = await session.request('undo'); if (r) vscode.window.showInformationMessage(`Ember: ${r.text}`); }),
    vscode.commands.registerCommand('ember.restart', async () => { await session.dispose(); await session.ensure().catch(() => {}); }),
    { dispose: () => session.dispose() }
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
