import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config/index.js';
import { signIpcResponsePayload } from '../infrastructure/ipc/response-signing.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../shared/private-fs.js';
import { getIpcResponseSigningPrivateKey } from './ipc-auth.js';

export function writeNotificationIpcResponse(input: {
  sourceAgentFolder: string;
  requestId: string;
  threadId?: string;
  responseKeyId?: string;
  ok: boolean;
  error?: string;
}): void {
  const responseDir = path.join(
    DATA_DIR,
    'ipc',
    input.sourceAgentFolder,
    'notification-responses',
  );
  ensurePrivateDirSync(responseDir);
  const responsePath = path.join(responseDir, `${input.requestId}.json`);
  const payload = {
    requestId: input.requestId,
    ok: input.ok,
    ...(input.error ? { error: input.error } : {}),
  };
  const privateKey = getIpcResponseSigningPrivateKey(
    input.sourceAgentFolder,
    input.threadId,
    input.responseKeyId,
  );
  const signature = signIpcResponsePayload(privateKey, payload);
  if (!signature) throw new Error('Notification response signing unavailable');
  const temporaryPath = `${responsePath}.tmp`;
  writePrivateFileSync(
    temporaryPath,
    JSON.stringify({ ...payload, signature }),
  );
  fs.renameSync(temporaryPath, responsePath);
}
