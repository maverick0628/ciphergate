#!/usr/bin/env node
/**
 * Copy the UI's static assets into dist.
 *
 * tsc only emits TypeScript output, so the HTML, CSS and JS the UI serves would
 * otherwise be missing from a built image and every asset request would 404.
 */
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/ui/public', import.meta.url));
const dest = fileURLToPath(new URL('../dist/ui/public', import.meta.url));

if (!existsSync(src)) {
  console.error(`UI assets not found at ${src}`);
  process.exit(1);
}

cpSync(src, dest, { recursive: true });
console.log(`UI assets copied to ${dest}`);
