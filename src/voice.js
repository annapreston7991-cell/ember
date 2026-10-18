/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { toolsDir } from './preview.js';
import { c } from './ui.js';

/** Find an executable on PATH (pure JS, so it works even where `which` isn't installed). */
export function which(b) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) { const p = path.join(dir, b + e); if (isExe(p)) return p; }
  }
  return null;
}
const isExe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

export const voiceDir = () => path.join(toolsDir(), 'voice');
export const venvPython = () => path.join(voiceDir(), 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

// ---------- microphone ----------

/** A command that records 16 kHz mono WAV from the default microphone into `out`, or null. */
export function findRecorder(out, { maxSec = 60 } = {}) {
  if (process.platform === 'linux' && which('arecord')) return { name: 'arecord', cmd: 'arecord', args: ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-d', String(maxSec), out] };
  if (which('rec')) return { name: 'sox', cmd: 'rec', args: ['-q', '-r', '16000', '-c', '1', '-b', '16', out, 'trim', '0', String(maxSec)] };
  if (which('ffmpeg')) {
    const input = process.platform === 'darwin' ? ['-f', 'avfoundation', '-i', ':0'] : process.platform === 'win32' ? ['-f', 'dshow', '-i', 'audio=default'] : ['-f', 'pulse', '-i', 'default'];
    return { name: 'ffmpeg', cmd: 'ffmpeg', args: ['-loglevel', 'error', '-y', ...input, '-t', String(maxSec), '-ac', '1', '-ar', '16000', out] };
  }
  return null;
}

/** Record until the user presses Enter (or maxSec). Resolves with the WAV path. */
export async function recordUntilEnter({ ui, maxSec = 60, waitForEnter }) {
  const out = path.join(os.tmpdir(), `ember-voice-${Date.now()}.wav`);
  const rec = findRecorder(out, { maxSec });
  if (!rec) throw new Error('NO_RECORDER');
  ui.print(c.red('● ') + `Listening (${rec.name})… press ${c.bold('Enter')} when you're done.`);
  const child = spawn(rec.cmd, rec.args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (b) => { err += b; });
  const exited = new Promise((r) => child.on('exit', r));
  await Promise.race([waitForEnter(), exited]);
  if (child.exitCode === null) {
    if (rec.name === 'ffmpeg') child.stdin.end('q'); else child.kill('SIGINT');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (!fs.existsSync(out) || fs.statSync(out).size < 2000) throw new Error(`Recording failed${err ? `: ${err.trim().split('\n').at(-1)}` : ' (no audio). Check your microphone.'}`);
  return out;
}

// ---------- speech to text ----------

// Decode the WAV ourselves (16 kHz mono float32), so faster-whisper never needs PyAV/ffmpeg to read it.
const FW_SCRIPT = `import sys, json, wave
import numpy as np
from faster_whisper import WhisperModel
def load(p):
    try:
        w = wave.open(p, "rb")
    except Exception:
        return p  # not a plain WAV: let faster-whisper decode it
    sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
    raw = w.readframes(w.getnframes())
    dt = {1: np.uint8, 2: np.int16, 4: np.int32}[sw]
    a = np.frombuffer(raw, dtype=dt).astype(np.float32)
    a = (a - 128) / 128 if sw == 1 else a / float(2 ** (8 * sw - 1))
    if ch > 1: a = a.reshape(-1, ch).mean(axis=1)
    if sr != 16000:
        n = int(len(a) * 16000 / sr)
        a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)
    return a
m = WhisperModel(sys.argv[2], device="auto", compute_type="int8")
segs, info = m.transcribe(load(sys.argv[1]), beam_size=1, vad_filter=True)
print(json.dumps({"text": " ".join(s.text.strip() for s in segs), "language": info.language}))
`;

/** Find a local speech-to-text engine: whisper.cpp, faster-whisper, or the openai-whisper CLI. */
export function findSTT(cfg = {}) {
  const v = cfg.voice || {};
  // whisper.cpp: a binary plus a ggml model file
  const wcBins = [v.whisperCpp, path.join(voiceDir(), 'whisper.cpp', 'build', 'bin', 'whisper-cli'), which('whisper-cli'), which('whisper-cpp')].filter(Boolean);
  const model = [v.whisperModel, path.join(voiceDir(), 'ggml-base.en.bin'), path.join(voiceDir(), 'ggml-base.bin')].filter(Boolean).find((p) => fs.existsSync(p));
  const wc = wcBins.find(isExe);
  if (wc && model) return { kind: 'whisper.cpp', bin: wc, model };
  // faster-whisper in Ember's own venv, or the system python
  for (const py of [venvPython(), which('python3'), which('python')].filter(Boolean)) {
    if (!isExe(py) && py === venvPython()) continue;
    const r = spawnSync(py, ['-c', 'import faster_whisper'], { encoding: 'utf8' });
    if (r.status === 0) return { kind: 'faster-whisper', python: py, model: v.sttModel || 'small.en' };
  }
  const ow = which('whisper');
  if (ow) return { kind: 'openai-whisper', bin: ow, model: v.sttModel || 'small.en' };
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    ch.stdout.on('data', (b) => { out += b; });
    ch.stderr.on('data', (b) => { err += b; });
    ch.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    ch.on('exit', (code) => resolve({ code, out, err }));
  });
}

/** Transcribe a WAV file locally. Returns the text. */
export async function transcribe(wav, stt) {
  if (stt.kind === 'whisper.cpp') {
    const r = await run(stt.bin, ['-m', stt.model, '-f', wav, '-nt', '-np']);
    if (r.code !== 0) throw new Error(`whisper.cpp failed: ${r.err.trim().split('\n').at(-1)}`);
    return cleanTranscript(r.out);
  }
  if (stt.kind === 'faster-whisper') {
    const script = path.join(os.tmpdir(), 'ember-fw.py');
    fs.writeFileSync(script, FW_SCRIPT);
    const r = await run(stt.python, [script, wav, stt.model]);
    if (r.code !== 0) throw new Error(`faster-whisper failed: ${r.err.trim().split('\n').slice(-2).join(' ')}`);
    try { return cleanTranscript(JSON.parse(r.out.trim().split('\n').at(-1)).text); } catch { throw new Error(`faster-whisper gave no text: ${r.out.slice(-200)}`); }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ow-'));
  const r = await run(stt.bin, [wav, '--model', stt.model, '--output_format', 'txt', '--output_dir', dir, '--fp16', 'False']);
  if (r.code !== 0) throw new Error(`whisper failed: ${r.err.trim().split('\n').at(-1)}`);
  const f = fs.readdirSync(dir).find((x) => x.endsWith('.txt'));
  return cleanTranscript(f ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
}

export function cleanTranscript(t) {
  return String(t || '')
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]|\((?:silence|music|noise)\)/gi, '')
    .replace(/\[\d\d:\d\d[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Install faster-whisper into ~/.ember/tools/voice/venv after asking. */
export async function installSTT({ ui }) {
  const py = which('python3') || which('python');
  if (!py) { ui.warn('Speech-to-text needs Python 3 (for faster-whisper) or whisper.cpp. Install one of them, then run `ember voice` again.'); return false; }
  const dir = voiceDir();
  const ok = await ui.confirm(`Voice needs a local speech-to-text engine. Install faster-whisper (~150 MB, plus a ~500 MB speech model on first use) into ${dir}?`, { allowAlways: false });
  if (ok !== 'y') return false;
  fs.mkdirSync(dir, { recursive: true });
  for (const [cmd, args] of [[py, ['-m', 'venv', path.join(dir, 'venv')]], [venvPython(), ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'faster-whisper']]]) {
    ui.print(c.gray(`  $ ${path.basename(cmd)} ${args.join(' ')}`));
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.status !== 0) { ui.warn(`${path.basename(cmd)} ${args.join(' ')} failed.`); return false; }
  }
  return true;
}

// ---------- text to speech ----------

/** Find a local text-to-speech engine: piper, say (macOS), espeak-ng/espeak, or Windows SAPI. */
export function findTTS(cfg = {}) {
  const v = cfg.voice || {};
  const piper = [v.piper, which('piper'), path.join(voiceDir(), 'piper', 'piper')].filter(Boolean).find(isExe);
  const voice = [v.piperVoice, ...(fs.existsSync(voiceDir()) ? fs.readdirSync(voiceDir()).filter((f) => f.endsWith('.onnx')).map((f) => path.join(voiceDir(), f)) : [])].filter(Boolean).find((p) => fs.existsSync(p));
  const player = which('aplay') || which('paplay') || which('afplay') || which('ffplay');
  if (piper && voice && player) return { kind: 'piper', bin: piper, voice, player };
  if (process.platform === 'darwin' && which('say')) return { kind: 'say', bin: 'say' };
  const es = which('espeak-ng') || which('espeak');
  if (es) return { kind: 'espeak', bin: es };
  if (process.platform === 'win32') return { kind: 'sapi', bin: 'powershell' };
  return null;
}

/** Turn an answer into something pleasant to hear: no code blocks, diffs or markdown; short. */
export function speakable(text, max = 400) {
  let t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code shown on screen) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*|__|\*|_/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = (end > 80 ? cut.slice(0, end + 1) : cut) + ' More is on screen.';
  }
  return t;
}

/** Speak text out loud. Returns false (quietly) if there's no TTS engine. */
export async function speak(text, tts) {
  const t = speakable(text);
  if (!t || !tts) return false;
  if (tts.kind === 'piper') {
    const wav = path.join(os.tmpdir(), `ember-tts-${Date.now()}.wav`);
    await new Promise((resolve) => { const ch = spawn(tts.bin, ['--model', tts.voice, '--output_file', wav], { stdio: ['pipe', 'ignore', 'ignore'] }); ch.on('exit', resolve); ch.on('error', resolve); ch.stdin.end(t); });
    if (!fs.existsSync(wav)) return false;
    const args = /ffplay/.test(tts.player) ? ['-nodisp', '-autoexit', '-loglevel', 'quiet', wav] : [wav];
    await run(tts.player, args);
    fs.rmSync(wav, { force: true });
    return true;
  }
  if (tts.kind === 'say') return (await run('say', [t])).code === 0;
  if (tts.kind === 'espeak') return (await run(tts.bin, [t])).code === 0;
  if (tts.kind === 'sapi') return (await run('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak([Console]::In.ReadToEnd())`], {})).code === 0;
  return false;
}

/** A short status line for doctor / help. */
export function voiceStatus(cfg) {
  const out = path.join(os.tmpdir(), 'x.wav');
  const rec = findRecorder(out);
  const stt = findSTT(cfg);
  const tts = findTTS(cfg);
  return { rec: rec?.name || null, stt: stt?.kind || null, tts: tts?.kind || null };
}

export const STOP_WORDS = /^(stop|exit|quit|goodbye|bye|that's all|that is all)[.!]?$/i;

/**
 * Get one spoken request: from a WAV file (`--file`) or the microphone. Installs STT after asking.
 * Returns the text, or null if voice isn't possible (the caller falls back to typing).
 */
export async function listenOnce({ ui, cfg, file, waitForEnter }) {
  let stt = findSTT(cfg);
  if (!stt && await installSTT({ ui })) stt = findSTT(cfg);
  if (!stt) { ui.warn('No speech-to-text engine, so voice is off. Install faster-whisper or whisper.cpp (see README › Voice), or keep typing.'); return null; }
  let wav = file;
  if (!wav) {
    try { wav = await recordUntilEnter({ ui, maxSec: cfg.voice?.maxSec ?? 60, waitForEnter }); }
    catch (e) {
      if (e.message === 'NO_RECORDER') ui.warn('No microphone recorder found (arecord, sox or ffmpeg). Install one, or use `ember voice --file speech.wav`.');
      else ui.warn(e.message);
      return null;
    }
  }
  ui.print(c.gray(`  · transcribing with ${stt.kind}…`));
  const t0 = Date.now();
  const text = await transcribe(wav, stt);
  if (!file) fs.rmSync(wav, { force: true });
  ui.print(c.cyan('you said › ') + (text || c.gray('(nothing heard)')) + c.gray(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`));
  return text;
}

/** `ember voice`: talk, Ember works, Ember answers out loud (when a TTS engine exists). */
export async function runVoice({ agent, ui, cfg, file, speakOut = cfg.voice?.tts !== false }) {
  const tts = speakOut ? findTTS(cfg) : null;
  if (speakOut && !tts) ui.print(c.gray('  (no text-to-speech found — install espeak-ng, piper, or use macOS `say`; answers stay on screen)'));
  ui.print(c.gray(`Voice mode. Say "stop" to finish.${file ? '' : ' Press Enter to start each request.'}`));
  for (;;) {
    if (!file) { const go = await ui.ask(c.gray('\n[Enter] to talk, or type a request › ')); if (go === null) return 0; if (go.trim()) { if (STOP_WORDS.test(go.trim())) return 0; await answer(go.trim()); continue; } }
    const text = await listenOnce({ ui, cfg, file, waitForEnter: () => ui.ask('') });
    if (text === null) return 1;
    if (text && STOP_WORDS.test(text.replace(/[.!?]+$/, '') + '')) { ui.print(c.gray('bye 🔥')); return 0; }
    if (text) await answer(text);
    if (file) return 0;
  }
  async function answer(text) {
    ui.print('');
    const out = await agent.runTask(text);
    ui.print('');
    if (tts && out) await speak(out, tts).catch(() => false);
  }
}
