/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { emberHome } from './config.js';

export class McpClientManager {
  constructor(root) {
    this.root = root;
    this.servers = new Map(); // name -> { proc, config, id, pending: Map }
    this.config = this.loadConfig();
  }

  loadConfig() {
    const paths = [
      path.join(this.root, '.ember', 'mcp.json'),
      path.join(emberHome(), 'mcp.json')
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.mcpServers === 'object') {
            return parsed.mcpServers;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return {};
  }

  listConfiguredServers() {
    return Object.keys(this.config);
  }

  async ensureServer(name) {
    if (this.servers.has(name)) return this.servers.get(name);
    const cfg = this.config[name];
    if (!cfg) throw new Error(`MCP server "${name}" is not configured in .ember/mcp.json`);

    const env = { ...process.env, ...(cfg.env || {}) };
    const child = spawn(cfg.command, cfg.args || [], {
      cwd: this.root,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const server = {
      name,
      proc: child,
      nextId: 1,
      pending: new Map(),
      buffer: ''
    };

    child.stdout.on('data', (data) => {
      server.buffer += data.toString();
      const lines = server.buffer.split('\n');
      server.buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id && server.pending.has(msg.id)) {
            const { resolve, reject } = server.pending.get(msg.id);
            server.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
            else resolve(msg.result);
          }
        } catch {
          /* line was not JSON */
        }
      }
    });

    child.on('error', (err) => {
      for (const { reject } of server.pending.values()) reject(err);
      server.pending.clear();
      this.servers.delete(name);
    });

    child.on('close', () => {
      for (const { reject } of server.pending.values()) reject(new Error('MCP server closed'));
      server.pending.clear();
      this.servers.delete(name);
    });

    this.servers.set(name, server);

    // Initial handshake (initialize)
    try {
      await this.sendRequest(server, 'initialize', {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'llyverse-ember', version: '0.3.0' },
        capabilities: {}
      });
      // notifications/initialized
      server.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    } catch {
      /* ignore init errors */
    }

    return server;
  }

  sendRequest(server, method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = server.nextId++;
      server.pending.set(id, { resolve, reject });
      const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      server.proc.stdin.write(req);

      setTimeout(() => {
        if (server.pending.has(id)) {
          server.pending.delete(id);
          reject(new Error(`MCP request ${method} (id=${id}) timed out after 30s`));
        }
      }, 30000).unref();
    });
  }

  async listTools(serverName) {
    const server = await this.ensureServer(serverName);
    const res = await this.sendRequest(server, 'tools/list');
    return res?.tools || [];
  }

  async callTool(serverName, toolName, args = {}) {
    const server = await this.ensureServer(serverName);
    const res = await this.sendRequest(server, 'tools/call', {
      name: toolName,
      arguments: args
    });
    if (res?.content && Array.isArray(res.content)) {
      return res.content.map((c) => c.text || JSON.stringify(c)).join('\n');
    }
    return JSON.stringify(res || {});
  }

  closeAll() {
    for (const [name, server] of this.servers.entries()) {
      try {
        server.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.servers.delete(name);
    }
  }
}
