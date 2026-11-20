import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  chmod,
  lstat,
  readdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config/index.js';
import { redactString } from '../infrastructure/logging/logger.js';

const MAX_OUTPUT_BYTES = 65536;
const MAX_FILES = 20;
const MAX_AGE_MS = 86400000;
/** Private failure evidence only. Never publish this record or log its content. */
export async function captureSourceOutputDiagnostic(
  input: {
    appId?: string;
    runId?: string;
    sourceIds?: readonly string[];
    output?: string;
    errors: readonly string[];
  },
  directory = path.join(
    process.env.GANTRY_IPC_DIR?.trim() || DATA_DIR,
    'private-source-diagnostics',
  ),
): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) return false;
    await chmod(directory, 0o700);
    const outputBytes =
      input.output === undefined ? 0 : Buffer.byteLength(input.output);
    const redacted =
      input.output === undefined ? undefined : redactString(input.output);
    const oversized =
      outputBytes > MAX_OUTPUT_BYTES ||
      (redacted !== undefined &&
        Buffer.byteLength(redacted) > MAX_OUTPUT_BYTES);
    const sourceIds = input.sourceIds ?? [];
    const sourceIdsFit = Buffer.byteLength(JSON.stringify(sourceIds)) <= 16384;
    const record = {
      version: 1,
      createdAt: new Date().toISOString(),
      appId: input.appId,
      runId: input.runId,
      sourceIds: sourceIdsFit ? sourceIds : undefined,
      sourceIdsOmitted: !sourceIdsFit,
      sourceIdsHash: createHash('sha256')
        .update(JSON.stringify(sourceIds))
        .digest('hex'),
      errors: input.errors
        .slice(0, 16)
        .map((error) => redactString(error).slice(0, 512)),
      errorsOmitted:
        input.errors.length > 16 ||
        input.errors.some((error) => error.length > 512),
      outputBytes,
      outputHash:
        input.output === undefined
          ? undefined
          : createHash('sha256').update(input.output).digest('hex'),
      outputStatus: oversized
        ? 'oversized_not_saved'
        : input.output === undefined
          ? 'unavailable'
          : redacted !== input.output
            ? 'credential_redacted'
            : 'complete',
      ...(oversized ? {} : { output: redacted }),
    };
    await writeFile(
      path.join(directory, `${randomUUID()}.json`),
      JSON.stringify(record),
      { flag: 'wx', mode: 0o600 },
    );
    const rows = (
      await Promise.all(
        (await readdir(directory))
          .filter((name) => /^[a-f0-9-]+\.json$/.test(name))
          .map(async (name) => {
            try {
              return {
                name,
                modified: (await stat(path.join(directory, name))).mtimeMs,
              };
            } catch {
              return undefined;
            }
          }),
      )
    ).filter(
      (row): row is { name: string; modified: number } => row !== undefined,
    );
    rows.sort((a, b) => b.modified - a.modified);
    await Promise.all(
      rows
        .filter(
          (row, index) =>
            index >= MAX_FILES || Date.now() - row.modified > MAX_AGE_MS,
        )
        .map((row) => unlink(path.join(directory, row.name)).catch(() => {})),
    );
    return true;
  } catch {
    return false;
  }
}
