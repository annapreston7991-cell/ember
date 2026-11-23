/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpClientManager } from '../src/mcp.js';

test('mcp: discovers config and executes tools over JSON-RPC stdio', async () => {
  const root = path.join(os.tmpdir(), `ember-mcp-test-${Date.now()}`);
  fs.mkdirSync(path.join(root, '.ember'), { recursive: true });

  // Create a minimal mock MCP server script
  const mockServerScript = path.join(root, 'mock_server.js');
  fs.writeFileSync(mockServerScript, `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (!msg.id) return; // notification
    if (msg.method === 'initialize') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' } } }));
    } else if (msg.method === 'tools/list') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo input' }] } }));
    } else if (msg.method === 'tools/call') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ECHO: ' + msg.params.arguments.text }] } }));
    }
  } catch (e) {}
});
`);

  // Write .ember/mcp.json
  fs.writeFileSync(path.join(root, '.ember', 'mcp.json'), JSON.stringify({
    mcpServers: {
      mock: {
        command: 'node',
        args: [mockServerScript]
      }
    }
  }));

  const mcp = new McpClientManager(root);
  const servers = mcp.listConfiguredServers();
  assert.deepEqual(servers, ['mock']);

  const tools = await mcp.listTools('mock');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo');

  const out = await mcp.callTool('mock', 'echo', { text: 'hello mcp' });
  assert.equal(out, 'ECHO: hello mcp');

  mcp.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
});
