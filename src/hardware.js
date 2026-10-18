/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 4000 });
  return r.status === 0 ? r.stdout : '';
};

/** NVIDIA: nvidia-smi reports MiB per GPU. */
export function parseNvidia(out) {
  const gpus = [];
  for (const line of String(out).trim().split('\n').filter(Boolean)) {
    const [name, mem] = line.split(',').map((s) => s.trim());
    if (name && Number(mem)) gpus.push({ vendor: 'nvidia', name, vramGB: Math.round(Number(mem) / 1024) });
  }
  return gpus;
}

/** AMD on Linux: amdgpu exposes VRAM in sysfs (no ROCm needed). */
export function amdFromSysfs(base = '/sys/class/drm') {
  const gpus = [];
  let cards = [];
  try { cards = fs.readdirSync(base).filter((d) => /^card\d+$/.test(d)); } catch { return gpus; }
  for (const card of cards) {
    const dev = path.join(base, card, 'device');
    try {
      const vendor = fs.readFileSync(path.join(dev, 'vendor'), 'utf8').trim();
      if (vendor !== '0x1002') continue;
      const bytes = Number(fs.readFileSync(path.join(dev, 'mem_info_vram_total'), 'utf8').trim());
      if (bytes > 512 * 1024 ** 2) gpus.push({ vendor: 'amd', name: `AMD GPU (${card})`, vramGB: Math.round(bytes / 1024 ** 3) });
    } catch { /* not amdgpu */ }
  }
  return gpus;
}

export function detectHardware() {
  const ramGB = Math.round(os.totalmem() / 1024 ** 3);
  const appleSilicon = process.platform === 'darwin' && os.arch() === 'arm64';
  let gpus = [];
  gpus.push(...parseNvidia(run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])));
  if (!gpus.length && process.platform === 'linux') gpus.push(...amdFromSysfs());
  if (!gpus.length) {
    const rocm = run('rocm-smi', ['--showmeminfo', 'vram', '--csv']);
    const m = rocm.match(/,(\d{9,})/);
    if (m) gpus.push({ vendor: 'amd', name: 'AMD GPU', vramGB: Math.round(Number(m[1]) / 1024 ** 3) });
  }
  let vramGB = gpus.reduce((mx, g) => Math.max(mx, g.vramGB), 0);
  let gpu = gpus[0]?.name || null;
  if (appleSilicon) {
    const chip = run('sysctl', ['-n', 'machdep.cpu.brand_string']).trim();
    gpu = `${chip || 'Apple Silicon'} (unified memory)`;
    vramGB = Math.floor(ramGB * 0.66); // macOS lets the GPU use about two thirds of RAM by default
  }
  return { ramGB, vramGB, gpu, gpus, appleSilicon, platform: process.platform, cpus: os.cpus().length };
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

/** Small model for quick jobs, or null when the main model is already small. */
export function pickFastModel(main, { vramGB = 0, appleSilicon = false } = {}) {
  const size = Number((String(main).match(/:(\d+(?:\.\d+)?)b/) || [])[1] || 0);
  if (!size || size <= 3) return null;
  return (vramGB >= 10 || appleSilicon) && size >= 14 ? 'qwen2.5-coder:3b' : 'qwen2.5-coder:1.5b';
}

/** Context window: bigger when there is GPU memory to spare. */
export function pickNumCtx({ vramGB = 0, appleSilicon = false, ramGB = 8 }) {
  if (vramGB >= 16 || (appleSilicon && ramGB >= 32)) return 16384;
  return 8192;
}
