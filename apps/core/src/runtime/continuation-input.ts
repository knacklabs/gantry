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

export function taskContinuationThreadId(
  threadId: string | null | undefined,
  parentTaskId: string | null | undefined,
): string | null | undefined {
  if (!parentTaskId) return threadId;
  const normalized = normalizeThreadQueueId(threadId);
  return normalized
    ? `${normalized}:task:${parentTaskId}`
    : `task:${parentTaskId}`;
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

export function continuationInputPath(
  workspaceFolder: string,
  sequence: number | string,
  threadId?: string | null,
): string {
  const inputDir = getContinuationInputDir(workspaceFolder, threadId);
  const filename = `${currentTimeMs()}-${String(sequence).padStart(12, '0')}.json`;
  return path.join(inputDir, filename);
}

export function closeSignalPath(
  workspaceFolder: string,
  threadId?: string | null,
): string {
  return path.join(
    getContinuationInputDir(workspaceFolder, threadId),
    '_close',
  );
}

export function writeContinuationInput(
  workspaceFolder: string,
  text: string,
  sequence: number | string,
  threadId?: string | null,
): void {
  const inputDir = getContinuationInputDir(workspaceFolder, threadId);
  fs.mkdirSync(inputDir, { recursive: true });
  const filepath = continuationInputPath(workspaceFolder, sequence, threadId);
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
  fs.writeFileSync(closeSignalPath(workspaceFolder, threadId), '');
}
