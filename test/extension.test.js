/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Drives the real VS Code extension code against a stub `vscode` module and a real `ember serve`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mockOllama, tmpdir, call } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'ember.js');

function stubVscode({ root, emberPath, answers }) {
  const commands = new Map();
  const executed = [];
  const posted = [];
  const providers = {};
  let view = null;
  const uri = (o) => ({ ...o, toString: () => `${o.scheme}:${o.path}?${o.query || ''}`, fsPath: o.path });
  const vscode = {
    EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
    Uri: { from: uri, file: (p) => uri({ scheme: 'file', path: p }), joinPath: (u, ...p) => uri({ scheme: 'file', path: path.join(u.path, ...p) }) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }],
      getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
      getConfiguration: () => ({ get: (k) => ({ path: emberPath, model: '', autoApprove: false })[k] }),
      registerTextDocumentContentProvider: (scheme, p) => { providers[scheme] = p; return { dispose() {} }; },
      asRelativePath: (u) => path.relative(root, u.fsPath)
    },
    window: {
      activeTextEditor: null,
      createOutputChannel: () => ({ appendLine() {}, append() {}, dispose() {} }),
      registerWebviewViewProvider: (id, p) => { providers[id] = p; return { dispose() {} }; },
      showInformationMessage: async (msg, ...items) => answers.info(msg, items),
      showWarningMessage: async (msg, opts, ...items) => answers.warn(msg, items),
      showErrorMessage: async () => {},
      showInputBox: async (o) => answers.input(o)
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...args) => {
        executed.push([id, ...args]);
        if (id === 'ember.chat.focus' && !view) {
          let handler;
          view = { show() {}, onDidDispose() {}, webview: { options: {}, cspSource: 'x', asWebviewUri: (u) => u, postMessage: (m) => { posted.push(m); return true; }, onDidReceiveMessage: (fn) => { handler = fn; } } };
          providers['ember.chat'].resolveWebviewView(view);
          view.send = (m) => handler(m);
        }
      }
    }
  };
  return { vscode, commands, executed, posted, providers, getView: () => view };
}

test('VS Code extension: chat → diff review → apply, explain selection, undo', async () => {
  const root = tmpdir('ember-ws-');
  fs.writeFileSync(path.join(root, 'math.js'), 'export const add = (a, b) => a + b;\n');
  const mock = await mockOllama({ script: [call('write_file', { path: 'greet.js', content: 'export const hi = () => "hi";\n' }), { content: 'Added greet.js.' }, { content: 'It adds a and b.' }] });
  const home = tmpdir('ember-home-');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'mock', host: mock.url, fastModel: null, memory: { enabled: false }, selfFix: { enabled: false }, index: { enabled: false }, git: { checkpoints: false } }));
  const wrapper = path.join(home, 'ember');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  const prevHome = process.env.EMBER_HOME;
  process.env.EMBER_HOME = home;
  const asked = [];
  const s = stubVscode({ root, emberPath: wrapper, answers: { info: async (msg, items) => { asked.push([msg, items]); return 'Apply'; }, warn: async () => 'Yes', input: async () => '' } });
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest); };
  createRequire(import.meta.url).cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: s.vscode };
  const ext = createRequire(import.meta.url)('../extension/extension.js');
  const context = { subscriptions: [], extensionUri: { path: path.join(here, '..', 'extension') } };
  try {
    ext.activate(context);
    for (const id of ['ember.explainSelection', 'ember.editSelection', 'ember.ask', 'ember.newChat', 'ember.stop', 'ember.undo', 'ember.restart']) assert.ok(s.commands.has(id), id);
    await s.vscode.commands.executeCommand('ember.chat.focus');
    assert.match(s.getView().webview.html, /Content-Security-Policy[\s\S]*nonce-/);
    await s.getView().send({ type: 'send', text: 'add greet.js' });
    assert.equal(fs.readFileSync(path.join(root, 'greet.js'), 'utf8'), 'export const hi = () => "hi";\n');
    const diff = s.executed.find(([id]) => id === 'vscode.diff');
    assert.ok(diff, 'diff editor opened');
    assert.match(diff[3], /Create greet\.js \(\+1/);
    assert.equal(s.providers['ember-proposed'].provideTextDocumentContent(diff[2]), 'export const hi = () => "hi";\n');
    assert.deepEqual(asked[0][1], ['Apply', 'Apply All', 'Reject']);
    assert.ok(s.posted.some((m) => m.type === 'done' && m.text === 'Added greet.js.'));
    assert.ok(s.posted.some((m) => m.type === 'info' && /Ember .* · mock/.test(m.text)));

    s.vscode.window.activeTextEditor = { selection: { isEmpty: false, start: { line: 0 }, end: { line: 0 } }, document: { uri: { fsPath: path.join(root, 'math.js') }, languageId: 'javascript', getText: () => 'export const add = (a, b) => a + b;' } };
    await s.commands.get('ember.explainSelection')();
    assert.ok(s.posted.some((m) => m.type === 'done' && m.text === 'It adds a and b.'));
    assert.match(mock.requests[2].messages.at(-1).content, /math\.js \(from line 1\)/);

    await s.getView().send({ type: 'undo' });
    assert.ok(!fs.existsSync(path.join(root, 'greet.js')));
  } finally {
    for (const d of context.subscriptions) await d.dispose?.();
    Module._resolveFilename = origResolve;
    if (prevHome === undefined) delete process.env.EMBER_HOME; else process.env.EMBER_HOME = prevHome;
    mock.server.close();
  }
});
