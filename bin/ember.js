#!/usr/bin/env node
/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then((code) => { process.exitCode = code ?? 0; }).catch((e) => {
  console.error(`ember: ${e.message}`);
  process.exit(1);
});
