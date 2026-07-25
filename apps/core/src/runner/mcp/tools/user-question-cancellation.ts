import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { createSignedIpcRequestEnvelope } from '../../../shared/ipc-signing.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../../../shared/private-fs.js';
import { nowIso } from '../../../shared/time/datetime.js';
import {
  agentId,
  appId,
  IPC_AUTH_TOKEN,
  IPC_DIR,
  threadId,
  workspaceFolder,
} from '../context.js';

export const CANCELLED_QUESTION_REASON = 'Question cancelled. Nothing changed.';

export function writeUserQuestionCancellation(input: {
  requestPath: string;
  requestId: string;
}): void {
  try {
    fs.unlinkSync(input.requestPath);
    return;
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code !== 'ENOENT') throw err;
  }

  const cancellationsDir = path.join(IPC_DIR, 'question-cancellations');
  ensurePrivateDirSync(cancellationsDir);
  const cancellationPath = path.join(
    cancellationsDir,
    `${input.requestId}.json`,
  );
  if (fs.existsSync(cancellationPath)) return;
  const cancellationTmpPath = `${cancellationPath}.tmp`;
  const payload = {
    requestId: `userq-cancel-${randomUUID()}`,
    questionRequestId: input.requestId,
    appId: appId || 'default',
    ...(agentId ? { agentId } : {}),
    sourceAgentFolder: workspaceFolder,
    reason: CANCELLED_QUESTION_REASON,
    context: {
      appId: appId || 'default',
      ...(agentId ? { agentId } : {}),
      ...(threadId ? { threadId } : {}),
    },
    timestamp: nowIso(),
  };
  const envelope = createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, payload);
  writePrivateFileSync(cancellationTmpPath, JSON.stringify(envelope, null, 2));
  fs.renameSync(cancellationTmpPath, cancellationPath);
}
