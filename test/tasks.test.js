/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskManager } from '../src/tasks.js';

test('tasks: quick command finishes synchronously', async () => {
  const mgr = new TaskManager(process.cwd());
  const res = await mgr.run({ cmd: 'echo "hello tasks"', waitMs: 3000 });
  assert.equal(res.synchronous, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.output, /hello tasks/);
});

test('tasks: long-running command backgrounded after waitMs', async () => {
  const mgr = new TaskManager(process.cwd());
  const exitPromise = new Promise((resolve) => {
    mgr.on('task_exit', resolve);
  });

  const res = await mgr.run({ cmd: 'node -e "setTimeout(() => console.log(\'done background\'), 200)"', waitMs: 50 });
  assert.equal(res.synchronous, false);
  assert.equal(res.status, 'running');
  assert.ok(res.taskId.startsWith('task-'));

  const list = mgr.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, res.taskId);

  // Wait for the exit event deterministically
  const exitEvent = await exitPromise;
  assert.equal(exitEvent.taskId, res.taskId);
  assert.equal(exitEvent.exitCode, 0);
  assert.match(exitEvent.output, /done background/);

  const status = mgr.status(res.taskId);
  assert.equal(status.status, 'completed');
});

test('tasks: sendInput and kill background task', async () => {
  const mgr = new TaskManager(process.cwd());
  const res = await mgr.run({
    cmd: 'read line; echo got:$line; sleep 10',
    waitMs: 50
  });

  assert.equal(res.status, 'running');
  mgr.sendInput(res.taskId, 'ping');

  // Poll briefly for output to arrive
  let status = null;
  for (let i = 0; i < 20; i++) {
    status = mgr.status(res.taskId);
    if (/got:ping/.test(status.output)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.match(status.output, /got:ping/);
  assert.equal(mgr.kill(res.taskId), true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(mgr.status(res.taskId).status, 'killed');
});
