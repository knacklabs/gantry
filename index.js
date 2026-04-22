#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const cliEntrypoint = join(packageRoot, 'dist', 'cli', 'index.js');

if (!existsSync(cliEntrypoint)) {
  console.error(
    'MyClaw build artifacts are missing. Run `npm run build` before `node index.js`.',
  );
  process.exit(1);
}

await import(pathToFileURL(cliEntrypoint).href);
