/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const q = document.getElementById('q');
  const stop = document.getElementById('stop');
  let live = null;
  const add = (cls, text) => { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
  document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); const t = q.value.trim(); if (!t) return; q.value = ''; vscode.postMessage({ type: 'send', text: t }); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('f').requestSubmit(); } });
  stop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'new' }));
  document.getElementById('undo').addEventListener('click', () => vscode.postMessage({ type: 'undo' }));
  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'user') { add('user', m.text); live = null; }
    else if (m.type === 'stream') { if (!live) live = add('bot', ''); live.textContent += m.text; log.scrollTop = log.scrollHeight; }
    else if (m.type === 'output') { if (m.text.trim()) add('tool', m.text); live = null; }
    else if (m.type === 'change') add('change', `${m.label} ${m.path}  (+${m.stats?.add ?? 0} −${m.stats?.del ?? 0}) — review the diff`);
    else if (m.type === 'done') { if (!live && m.text) add('bot', m.text); live = null; }
    else if (m.type === 'error') add('error', m.text);
    else if (m.type === 'info') add('info', m.text);
    else if (m.type === 'plan') { if (m.text && m.text.trim() && !/^\s*$/.test(m.text)) add('plan', m.text); }
    else if (m.type === 'busy') { stop.disabled = !m.busy; document.getElementById('send').disabled = m.busy; }
    else if (m.type === 'cleared') { log.innerHTML = ''; add('info', 'New chat.'); }
  });
}());
