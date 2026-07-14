import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import openapiTS, { astToString } from 'openapi-typescript';

import { getGantryOpenApiDocument } from '../../../apps/core/src/control/server/openapi.js';

const outputPath = fileURLToPath(
  new URL('../src/generated/openapi.ts', import.meta.url),
);
const output = `${astToString(await openapiTS(getGantryOpenApiDocument())).trimEnd()}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== output) {
    console.error('Generated OpenAPI types are stale. Run npm run generate.');
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
}
