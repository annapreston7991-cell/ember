/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { quietUI, tmpdir } from './helpers.js';

const v = await import('../src/voice.js');
const { DEFAULTS } = await import('../src/config.js');

/** Run fn with a PATH holding only fake binaries (plus node's own dir), and a private EMBER_HOME. */
async function withFakeBins(bins, fn) {
  const dir = tmpdir('ember-bin-');
  for (const [name, body] of Object.entries(bins)) { fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(dir, name), 0o755); }
  const saved = { PATH: process.env.PATH, EMBER_HOME: process.env.EMBER_HOME };
  process.env.PATH = dir;
  process.env.EMBER_HOME = tmpdir('ember-home-');
  try { return await fn(dir); } finally { process.env.PATH = saved.PATH; if (saved.EMBER_HOME === undefined) delete process.env.EMBER_HOME; else process.env.EMBER_HOME = saved.EMBER_HOME; }
}

test('transcripts are cleaned and answers made speakable', () => {
  assert.equal(v.cleanTranscript('[00:00:00.000 --> 00:00:02.000]  Add a test [BLANK_AUDIO]\n'), 'Add a test');
  const s = v.speakable('## Done\n- Updated **app.js**\n```js\nconsole.log(1)\n```\nSee https://example.com for `more`.');
  assert.doesNotMatch(s, /```|\*\*|##|https/);
  assert.match(s, /code shown on screen/);
  assert.match(s, /a link/);
  assert.ok(v.speakable('word. '.repeat(200)).length < 450);
  assert.ok(v.STOP_WORDS.test('Stop.') && !v.STOP_WORDS.test('stop the server'));
});

test('recorder detection prefers arecord on Linux, then sox, then ffmpeg', async () => {
  await withFakeBins({ ffmpeg: 'exit 0' }, () => assert.equal(v.findRecorder('/tmp/x.wav').name, 'ffmpeg'));
  await withFakeBins({ ffmpeg: 'exit 0', rec: 'exit 0' }, () => assert.equal(v.findRecorder('/tmp/x.wav').name, 'sox'));
  if (process.platform === 'linux') await withFakeBins({ ffmpeg: 'exit 0', arecord: 'exit 0' }, () => assert.equal(v.findRecorder('/tmp/x.wav').name, 'arecord'));
  await withFakeBins({}, () => assert.equal(v.findRecorder('/tmp/x.wav'), null));
});

test('whisper.cpp is used when its binary and model exist; espeak speaks the answer', async () => {
  await withFakeBins({
    'whisper-cli': 'echo "[00:00:00.000 --> 00:00:01.000]   Add a health route."',
    'espeak-ng': 'echo "$@" > "$EMBER_HOME/spoken.txt"'
  }, async () => {
    fs.mkdirSync(v.voiceDir(), { recursive: true });
    fs.writeFileSync(path.join(v.voiceDir(), 'ggml-base.en.bin'), 'x');
    const stt = v.findSTT({});
    assert.equal(stt.kind, 'whisper.cpp');
    const wav = path.join(tmpdir(), 'a.wav'); fs.writeFileSync(wav, Buffer.alloc(4000));
    assert.equal(await v.transcribe(wav, stt), 'Add a health route.');
    const tts = v.findTTS({});
    assert.equal(tts.kind, 'espeak');
    assert.ok(await v.speak('Added **GET /health** and a test.', tts));
    assert.equal(fs.readFileSync(path.join(process.env.EMBER_HOME, 'spoken.txt'), 'utf8').trim(), 'Added GET /health and a test.');
    assert.deepEqual(v.voiceStatus({}), { rec: null, stt: 'whisper.cpp', tts: 'espeak' });
  });
});

test('ember voice --file: transcribes, runs the task, speaks; "stop" ends', async () => {
  await withFakeBins({ 'whisper-cli': 'echo "  Add a readme. "', 'espeak-ng': 'echo "$@" >> "$EMBER_HOME/spoken.txt"' }, async () => {
    fs.mkdirSync(v.voiceDir(), { recursive: true });
    fs.writeFileSync(path.join(v.voiceDir(), 'ggml-base.en.bin'), 'x');
    const wav = path.join(tmpdir(), 'a.wav'); fs.writeFileSync(wav, Buffer.alloc(4000));
    const tasks = [];
    const agent = { runTask: async (t) => { tasks.push(t); return 'Created README.md.'; } };
    const { ui, text } = quietUI([], { yes: true });
    assert.equal(await v.runVoice({ agent, ui, cfg: structuredClone(DEFAULTS), file: wav }), 0);
    assert.deepEqual(tasks, ['Add a readme.']);
    assert.match(text(), /you said › Add a readme\./);
    assert.match(fs.readFileSync(path.join(process.env.EMBER_HOME, 'spoken.txt'), 'utf8'), /Created README\.md\./);
  });
  await withFakeBins({ 'whisper-cli': 'echo "Stop."' }, async () => {
    fs.mkdirSync(v.voiceDir(), { recursive: true });
    fs.writeFileSync(path.join(v.voiceDir(), 'ggml-base.en.bin'), 'x');
    const wav = path.join(tmpdir(), 'a.wav'); fs.writeFileSync(wav, Buffer.alloc(4000));
    const agent = { runTask: async () => { throw new Error('should not run'); } };
    const { ui, text } = quietUI([], { yes: true });
    assert.equal(await v.runVoice({ agent, ui, cfg: structuredClone(DEFAULTS), file: wav }), 0);
    assert.match(text(), /no text-to-speech found/);
  });
});

test('no speech engine and install declined: voice degrades with a clear message', async () => {
  await withFakeBins({}, async () => {
    const { ui, text } = quietUI(['n']);
    const r = await v.listenOnce({ ui, cfg: structuredClone(DEFAULTS), file: '/tmp/none.wav', waitForEnter: async () => '' });
    assert.equal(r, null);
    const out = text();
    if (/needs Python 3/.test(out)) return; // no python on this machine: also a graceful message
    assert.match(out, /Install faster-whisper/);
    assert.match(out, /voice is off/);
  });
});

test('microphone missing: listenOnce explains and returns null', async () => {
  await withFakeBins({ 'whisper-cli': 'echo hi' }, async () => {
    fs.mkdirSync(v.voiceDir(), { recursive: true });
    fs.writeFileSync(path.join(v.voiceDir(), 'ggml-base.en.bin'), 'x');
    const { ui, text } = quietUI([]);
    assert.equal(await v.listenOnce({ ui, cfg: structuredClone(DEFAULTS), waitForEnter: async () => '' }), null);
    assert.match(text(), /No microphone recorder found/);
  });
});
