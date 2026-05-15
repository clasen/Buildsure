#!/usr/bin/env node
// Drop-in replacement for ensure_builds.js using buildsure.
// 205 lines → 17 lines.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import BuildSure from 'buildsure';

const root = dirname(fileURLToPath(import.meta.url));
const bs = new BuildSure({ preferred: ['pnpm', 'npm'], verbose: true });

await bs.ensure(root);
const result = await bs.ensureAll(join(root, 'www'));

console.log(`built: ${result.successful.length}, up-to-date: ${result.upToDate.length}, failed: ${result.failed.length}`);
process.exit(result.failed.length ? 1 : 0);
