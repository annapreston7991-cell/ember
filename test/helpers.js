/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable, PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';

/** Mock Ollama: script is an array of { content, tool_calls } replies, or a function(req) -> reply. */
export function mockOllama({ tools = true, script = [], models = ['mock:latest'] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: 'mock' }));
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: models.map((name) => ({ name, model: name, size: 1 })) }));
      if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: tools ? ['completion', 'tools'] : ['completion'] }));
      if (req.url === '/api/chat') {
        requests.push(j);
        const step = (typeof script === 'function' ? script(j, requests.length) : script.shift()) || { content: 'done' };
        res.setHeader('content-type', 'application/x-ndjson');
        res.end(JSON.stringify({ message: { role: 'assistant', content: step.content || '', tool_calls: step.tool_calls }, done: true }) + '\n');
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

export function quietUI(answers = [], { yes = false } = {}) {
  let out = '';
  const output = new Writable({ write(chunk, _e, cb) { out += chunk; cb(); } });
  const input = new PassThrough();
  const ui = new UI({ yes, input, output });
  for (const a of answers) input.write(a + '\n');
  return { ui, text: () => out };
}

export function tmpdir(prefix = 'ember-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

export const call = (name, args) => ({ tool_calls: [{ function: { name, arguments: args } }] });
