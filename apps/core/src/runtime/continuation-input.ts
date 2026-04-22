import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../core/config.js';
import { normalizeThreadQueueId } from './thread-queue-key.js';

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
  groupFolder: string,
  threadId?: string | null,
): string {
  return path.join(
    DATA_DIR,
    'ipc',
    groupFolder,
    getContinuationInputNamespace(threadId),
  );
}

export function writeContinuationInput(
  groupFolder: string,
  text: string,
  sequence: number,
  threadId?: string | null,
): void {
  const inputDir = getContinuationInputDir(groupFolder, threadId);
  fs.mkdirSync(inputDir, { recursive: true });
  const filename = `${Date.now()}-${String(sequence).padStart(12, '0')}.json`;
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
  groupFolder: string,
  threadId?: string | null,
): void {
  const inputDir = getContinuationInputDir(groupFolder, threadId);
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, '_close'), '');
}
