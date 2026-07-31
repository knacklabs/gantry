import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { ATTACHMENT_UNREACHABLE_COPY } from '@core/application/attachments/attachment-resolver.js';
import { attachmentOpenTaskHandlers } from '@core/jobs/ipc-attachment-open-handler.js';
import { taskIpcResponsePath } from '@core/jobs/ipc-shared.js';
import {
  createIpcAuthEnvelope,
  revokeIpcResponseSigningKey,
} from '@core/runtime/ipc-auth.js';

const sourceAgentFolder = 'attachment_test';
const taskId = 'attachment-error-sanitization';
const responsePath = taskIpcResponsePath(sourceAgentFolder, taskId);
let responseKeyId: string | undefined;

afterEach(() => {
  fs.rmSync(responsePath, { force: true });
  if (responseKeyId) {
    revokeIpcResponseSigningKey(responseKeyId, sourceAgentFolder);
    responseKeyId = undefined;
  }
});

describe('attachment open IPC handler', () => {
  it('keeps host filesystem errors out of the runner response', async () => {
    const envelope = createIpcAuthEnvelope(sourceAgentFolder);
    responseKeyId = envelope.responseKeyId;
    const handler = attachmentOpenTaskHandlers.attachment_open;
    if (!handler) throw new Error('attachment_open handler is not registered');

    await handler({
      data: {
        type: 'attachment_open',
        taskId,
        appId: 'app-1',
        providerAccountId: 'slack-default',
        chatJid: 'sl:C1',
        targetJid: 'sl:C1',
        responseKeyId,
        payload: { attachmentId: 'attachment-1' },
      },
      sourceAgentFolder,
      sourceAgentFolderJids: ['sl:C1'],
      conversationBindings: {},
      deps: {
        openAttachment: async () => {
          throw new Error(
            "EACCES: permission denied, open '/private/host/attachments/secret'",
          );
        },
      } as never,
    });

    const responseText = fs.readFileSync(responsePath, 'utf8');
    expect(responseText).not.toContain('/private/host');
    expect(JSON.parse(responseText)).toMatchObject({
      ok: true,
      data: { content: ATTACHMENT_UNREACHABLE_COPY },
    });
  });
});
