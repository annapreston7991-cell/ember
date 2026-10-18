/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import { OllamaClient } from './ollama.js';
import { OpenAICompatClient, parseModelRef, providerConfig } from './cloud.js';
import { requirePro } from './pro.js';

/** Returns { client, model } for a model reference (local Ollama name or cloud:...). */
export function clientFor(ref, cfg) {
  const cloud = parseModelRef(ref, cfg);
  if (!cloud) return { client: new OllamaClient(cfg.host, { keepAlive: cfg.keepAlive }), model: ref, cloud: false };
  requirePro(cfg, 'cloud-models'); // local models are always free; cloud models are Ember Pro
  return { client: new OpenAICompatClient(providerConfig(cloud.provider, cfg)), model: cloud.model, cloud: true, provider: cloud.provider };
}
