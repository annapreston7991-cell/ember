/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Hook for a future paid "Ember Pro" tier (planned: cloud model credits, team memory,
// premium plugins, sold through the LLYVerse store / Stripe). There is NO billing code here.
// Everything in Ember today is free. Features can check isPro() later without refactoring.

export const PRO_FEATURES = ['team-memory', 'premium-plugins', 'hosted-cloud-models'];

export function isPro(cfg = {}) {
  // Intentionally always false until Pro launches. A future version will verify
  // cfg.pro.licenseKey locally/offline-first. Do not gate existing free features on this.
  return Boolean(cfg.pro?.enabled && cfg.pro?.licenseKey && process.env.EMBER_PRO_PREVIEW === '1');
}
