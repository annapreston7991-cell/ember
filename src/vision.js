/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Screenshot / image input. A local vision model (default qwen2.5vl:3b) looks at the
// image and describes it; that description is handed to the coding model, so any coding
// model can "see". Images are read only from paths the user typed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const IMAGE_RE = /(?:^|[\s('"`])((?:~|\.{0,2}\/)?[^\s'"`()]+?\.(?:png|jpe?g|webp|gif|bmp))(?=[\s,;:!?)'"`]|\.(?:\s|$)|$)/gi;
export const DEFAULT_VISION_MODEL = 'qwen2.5vl:3b';

/** Find image paths mentioned in a prompt that actually exist. */
export function findImagePaths(text, root) {
  const out = [];
  for (const m of String(text).matchAll(IMAGE_RE)) {
    const raw = m[1];
    const p = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : path.resolve(root, raw);
    if (fs.existsSync(p) && fs.statSync(p).isFile() && !out.includes(p)) out.push(p);
  }
  return out;
}

export function loadImage(p) {
  const st = fs.statSync(p);
  if (st.size > 20 * 1024 * 1024) throw new Error(`${p} is larger than 20 MB`);
  return fs.readFileSync(p).toString('base64');
}

/** Ask the vision model to describe images for a coding task. Returns text. */
export async function describeImages({ client, model, paths, question, signal }) {
  const images = paths.map(loadImage);
  const prompt = `You are helping a coding assistant that cannot see images.
Describe these image(s) precisely for a developer: visible UI, layout, colors, text (transcribe error
messages and code exactly), and anything that looks broken. The user's request: "${question}"`;
  const r = await client.chat({ model, messages: [{ role: 'user', content: prompt, images }], options: { temperature: 0.1 }, signal });
  return r.content.trim();
}
