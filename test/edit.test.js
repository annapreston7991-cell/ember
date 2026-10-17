/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit } from '../src/edit.js';

test('replaces a unique snippet', () => {
  assert.equal(applyEdit('a\nb\nc\n', 'b', 'B'), 'a\nB\nc\n');
});

test('replacement text with $ patterns is literal', () => {
  assert.equal(applyEdit('price = 1', '1', '$& $1 $$'), 'price = $& $1 $$');
});

test('ambiguous match is an error unless replace_all', () => {
  assert.throws(() => applyEdit('x x', 'x', 'y'), /matches 2 times/);
  assert.equal(applyEdit('x x', 'x', 'y', { replaceAll: true }), 'y y');
});

test('missing text is an error', () => {
  assert.throws(() => applyEdit('abc', 'zzz', 'y'), /not found/);
  assert.throws(() => applyEdit('abc', '', 'y'), /non-empty/);
});

test('CRLF files accept LF search text', () => {
  assert.equal(applyEdit('one\r\ntwo\r\nthree\r\n', 'one\ntwo', 'uno\ndos'), 'uno\r\ndos\r\nthree\r\n');
});

test('trailing whitespace differences are tolerated', () => {
  const src = 'function a() {   \n  return 1;\n}\n';
  assert.equal(applyEdit(src, 'function a() {\n  return 1;', 'function a() {\n  return 2;'), 'function a() {\n  return 2;\n}\n');
});
