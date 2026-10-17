/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, findJsonObjects } from '../src/parser.js';

const NAMES = ['read_file', 'write_file', 'list_dir', 'run_command'];

test('bare JSON tool call', () => {
  const r = parseToolCalls('Let me look.\n{"tool": "read_file", "arguments": {"path": "a.js"}}', NAMES);
  assert.deepEqual(r.calls, [{ name: 'read_file', arguments: { path: 'a.js' } }]);
  assert.equal(r.text, 'Let me look.');
});

test('name/arguments shape inside a json fence', () => {
  const r = parseToolCalls('```json\n{"name":"list_dir","arguments":{"path":"."}}\n```', NAMES);
  assert.deepEqual(r.calls, [{ name: 'list_dir', arguments: { path: '.' } }]);
  assert.equal(r.text, '');
});

test('<tool_call> tags, several calls, string arguments', () => {
  const first = JSON.stringify({ name: 'read_file', arguments: JSON.stringify({ path: 'x' }) });
  const r = parseToolCalls(`<tool_call>${first}</tool_call>\n<tool_call>{"name":"run_command","arguments":{"command":"npm test"}}</tool_call>`, NAMES);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[0].arguments, { path: 'x' });
  assert.equal(r.calls[1].arguments.command, 'npm test');
});

test('braces inside strings do not confuse the parser', () => {
  const content = 'function f() { return 1; }';
  const r = parseToolCalls(JSON.stringify({ tool: 'write_file', args: { path: 'f.js', content } }), NAMES);
  assert.equal(r.calls[0].arguments.content, content);
});

test('function wrapper and tool_calls array', () => {
  const r = parseToolCalls('{"tool_calls":[{"function":{"name":"list_dir","arguments":{}}}]}', NAMES);
  assert.deepEqual(r.calls, [{ name: 'list_dir', arguments: {} }]);
});

test('plain prose and unknown tools are not tool calls', () => {
  assert.equal(parseToolCalls('All done! The config is {"port": 3000}.', NAMES).calls.length, 0);
  assert.equal(parseToolCalls('{"tool":"delete_everything","arguments":{}}', NAMES).calls.length, 0);
  assert.equal(parseToolCalls('', NAMES).calls.length, 0);
});

test('findJsonObjects skips broken JSON and keeps going', () => {
  const objs = findJsonObjects('{ broken  {"a":1} trailing {"b":{"c":2}}');
  assert.deepEqual(objs.map((o) => o.value), [{ a: 1 }, { b: { c: 2 } }]);
});
