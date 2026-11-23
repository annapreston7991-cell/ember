/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MAX_TASK_LOG_CHARS = 50000;

export class TaskManager extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.tasks = new Map();
    this.nextId = 1;
  }

  /**
   * Run a command with an optional synchronous wait window.
   * If it completes within waitMs, returns { synchronous: true, exitCode, output }.
   * If it keeps running, returns { synchronous: false, taskId, status: 'running' }.
   */
  async run({ cmd, cwd = this.root, waitMs = 0, isDaemon = false, onOutput = null }) {
    const taskId = `task-${this.nextId++}`;
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
    const env = { ...process.env, EMBER: '1' };
    delete env.NODE_TEST_CONTEXT;

    const child = spawn(shell, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const task = {
      id: taskId,
      command: cmd,
      pid: child.pid,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      isDaemon: Boolean(isDaemon),
      output: '',
      child
    };

    const append = (data) => {
      const s = data.toString();
      task.output = (task.output + s).slice(-MAX_TASK_LOG_CHARS);
      if (typeof onOutput === 'function') onOutput(s);
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);

    let finished = false;
    let finishResolve = null;
    const finishPromise = new Promise((r) => { finishResolve = r; });

    child.on('close', (code) => {
      finished = true;
      if (task.status !== 'killed') {
        task.status = code === 0 ? 'completed' : 'failed';
      }
      task.exitCode = code;
      this.emit('task_exit', { taskId, exitCode: code, output: task.output, status: task.status });
      if (finishResolve) finishResolve();
    });

    child.on('error', (err) => {
      finished = true;
      task.status = 'failed';
      task.output += `\n[error] ${err.message}`;
      this.emit('task_exit', { taskId, exitCode: -1, output: task.output });
      if (finishResolve) finishResolve();
    });

    this.tasks.set(taskId, task);

    if (waitMs > 0) {
      const waitPromise = new Promise((r) => setTimeout(r, waitMs));
      await Promise.race([finishPromise, waitPromise]);
    }

    if (finished) {
      return {
        synchronous: true,
        taskId,
        exitCode: task.exitCode,
        output: task.output.trim() || '(no output)'
      };
    }

    return {
      synchronous: false,
      taskId,
      pid: task.pid,
      status: 'running',
      recentOutput: task.output.slice(-2000).trim() || '(running in background)'
    };
  }

  list() {
    return Array.from(this.tasks.values()).map((t) => ({
      taskId: t.id,
      command: t.command,
      pid: t.pid,
      status: t.status,
      exitCode: t.exitCode,
      runtimeSec: Math.round((Date.now() - t.startedAt) / 1000),
      isDaemon: t.isDaemon
    }));
  }

  status(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    return {
      taskId: t.id,
      command: t.command,
      pid: t.pid,
      status: t.status,
      exitCode: t.exitCode,
      runtimeSec: Math.round((Date.now() - t.startedAt) / 1000),
      output: t.output.trim() || '(no output)'
    };
  }

  sendInput(taskId, input) {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'running' || !t.child?.stdin?.writable) {
      return false;
    }
    t.child.stdin.write(input.endsWith('\n') ? input : input + '\n');
    return true;
  }

  kill(taskId) {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'running') return false;
    try {
      if (process.platform !== 'win32') {
        process.kill(-t.pid, 'SIGTERM');
      } else {
        t.child.kill('SIGTERM');
      }
    } catch {
      try { t.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    setTimeout(() => {
      if (t.status === 'running') {
        try {
          if (process.platform !== 'win32') process.kill(-t.pid, 'SIGKILL');
          else t.child.kill('SIGKILL');
        } catch { /* ignore */ }
      }
    }, 2000).unref();
    t.status = 'killed';
    return true;
  }

  killAll() {
    for (const t of this.tasks.values()) {
      if (t.status === 'running') this.kill(t.id);
    }
  }
}
