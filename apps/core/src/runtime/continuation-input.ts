import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config/index.js';
import { normalizeThreadQueueId } from '../shared/thread-queue-key.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';

const THREAD_INPUT_PREFIX = 'thread-';

export function getContinuationInputNamespace(
  threadId?: string | null,
): string {
  const normalized = normalizeThreadQueueId(threadId);
  return normalized
    ? path.join(
        'input',
        `${THREAD_INPUT_PREFIX}${encodeURIComponent(normalized)}`,
      )
    : 'input';
}

export function getContinuationInputDir(
  workspaceFolder: string,
  threadId?: string | null,
): string {
  return path.join(
    DATA_DIR,
    'ipc',
    workspaceFolder,
    getContinuationInputNamespace(threadId),
  );
}

export function writeContinuationInput(
  workspaceFolder: string,
  text: string,
  sequence: number,
  threadId?: string | null,
): void {
  const inputDir = getContinuationInputDir(workspaceFolder, threadId);
  fs.mkdirSync(inputDir, { recursive: true });
  const filename = `${currentTimeMs()}-${String(sequence).padStart(12, '0')}.json`;
  const filepath = path.join(inputDir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(
    tempPath,
    JSON.stringify({
      type: 'message',
      text,
      ...(threadId ? { threadId } : {}),
    }),
  );
  fs.renameSync(tempPath, filepath);
}

export function writeCloseSignal(
  workspaceFolder: string,
  threadId?: string | null,
): void {
  const inputDir = getContinuationInputDir(workspaceFolder, threadId);
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, '_close'), '');
}
