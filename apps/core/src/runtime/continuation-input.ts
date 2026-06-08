import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config/index.js';
import { normalizeThreadQueueId } from '../shared/thread-queue-key.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';

const THREAD_INPUT_PREFIX = 'thread-';
const CONVERSATION_INPUT_PREFIX = 'conv-';

// The continuation-input mailbox is isolated PER CONVERSATION (chatJid), not per
// agent. One agent (e.g. boondi_support) serves many concurrent customers;
// keying only by the agent folder (+ a null threadId for DMs) made them share a
// single `…/<agent>/input/` directory, so concurrent customers' follow-up
// messages bled into each other's running sessions. The conversation jid is the
// isolation key; an optional threadId nests sub-threads under that conversation.
export function getContinuationInputNamespace(
  chatJid: string,
  threadId?: string | null,
): string {
  const convPart = `${CONVERSATION_INPUT_PREFIX}${encodeURIComponent(chatJid)}`;
  const normalized = normalizeThreadQueueId(threadId);
  return normalized
    ? path.join(
        'input',
        convPart,
        `${THREAD_INPUT_PREFIX}${encodeURIComponent(normalized)}`,
      )
    : path.join('input', convPart);
}

export function getContinuationInputDir(
  groupFolder: string,
  chatJid: string,
  threadId?: string | null,
): string {
  return path.join(
    DATA_DIR,
    'ipc',
    groupFolder,
    getContinuationInputNamespace(chatJid, threadId),
  );
}

export function writeContinuationInput(
  groupFolder: string,
  chatJid: string,
  text: string,
  sequence: number,
  threadId?: string | null,
): void {
  const inputDir = getContinuationInputDir(groupFolder, chatJid, threadId);
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
  groupFolder: string,
  chatJid: string,
  threadId?: string | null,
): void {
  const inputDir = getContinuationInputDir(groupFolder, chatJid, threadId);
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, '_close'), '');
}
