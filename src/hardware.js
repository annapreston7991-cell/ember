/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export function detectHardware() {
  const ramGB = Math.round(os.totalmem() / 1024 ** 3);
  let vramGB = 0, gpu = null;
  const nv = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
  if (nv.status === 0 && nv.stdout.trim()) {
    for (const line of nv.stdout.trim().split('\n')) {
      const [name, mem] = line.split(',').map((s) => s.trim());
      vramGB = Math.max(vramGB, Math.round(Number(mem) / 1024));
      gpu = name;
    }
  } else {
    const rocm = spawnSync('rocm-smi', ['--showmeminfo', 'vram', '--csv'], { encoding: 'utf8' });
    if (rocm.status === 0) {
      const m = rocm.stdout.match(/,(\d{9,})/);
      if (m) { vramGB = Math.round(Number(m[1]) / 1024 ** 3); gpu = 'AMD GPU'; }
    }
  }
  const appleSilicon = process.platform === 'darwin' && os.arch() === 'arm64';
  if (appleSilicon) gpu = 'Apple Silicon (unified memory)';
  return { ramGB, vramGB, gpu, appleSilicon, platform: process.platform, cpus: os.cpus().length };
}

/** Pick a qwen2.5-coder size that will run comfortably on this machine. */
export function pickModel({ ramGB, vramGB = 0, appleSilicon = false }) {
  const tag = (t) => `qwen2.5-coder:${t}`;
  if (appleSilicon) {
    if (ramGB >= 64) return tag('32b');
    if (ramGB >= 32) return tag('14b');
    if (ramGB >= 16) return tag('7b');
    if (ramGB >= 8) return tag('3b');
    return tag('1.5b');
  }
  if (vramGB >= 22 && ramGB >= 32) return tag('32b');
  if (vramGB >= 10 && ramGB >= 16) return tag('14b');
  if (vramGB >= 6) return tag('7b');
  // CPU only (or a small GPU): bigger models get very slow.
  if (ramGB >= 12) return tag('7b');
  if (ramGB >= 6) return tag('3b');
  return tag('1.5b');
}
