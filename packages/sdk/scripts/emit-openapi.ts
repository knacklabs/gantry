import { writeFile } from 'node:fs/promises';

import { getGantryOpenApiDocument } from '../../../apps/core/src/control/server/openapi.js';

const output = `${JSON.stringify(getGantryOpenApiDocument(), null, 2)}\n`;
const outputPath = process.argv[2];

if (outputPath) await writeFile(outputPath, output);
else process.stdout.write(output);
