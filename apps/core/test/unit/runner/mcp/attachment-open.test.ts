import { describe, expect, it } from 'vitest';

import {
  attachmentOpenResponseText,
  attachmentOpenTaskRequest,
} from '@core/runner/mcp/attachment-open-protocol.js';
import { isLongRunningTask } from '@core/runtime/ipc-long-running-task.js';
import { createAttachmentOpenProof } from '@core/shared/attachment-open-auth-proof.js';

describe('attachment_open MCP bridge', () => {
  it('sends only the opaque attachment id and runner conversation identity', () => {
    expect(isLongRunningTask('attachment_open')).toBe(true);
    expect(
      attachmentOpenTaskRequest({
        attachmentId: 'message-attachment:provider-fetch:m1:slack:file_id:F1',
        chatJid: 'sl:C1',
        threadId: '1700000000.0001',
        taskId: 'attachment-open-1',
        authToken: 'chat-scoped-token',
      }),
    ).toEqual({
      type: 'attachment_open',
      taskId: 'attachment-open-1',
      chatJid: 'sl:C1',
      targetJid: 'sl:C1',
      payload: {
        attachmentId: 'message-attachment:provider-fetch:m1:slack:file_id:F1',
        conversationProof: createAttachmentOpenProof('chat-scoped-token', {
          attachmentId: 'message-attachment:provider-fetch:m1:slack:file_id:F1',
          chatJid: 'sl:C1',
          threadId: '1700000000.0001',
          taskId: 'attachment-open-1',
        }),
      },
    });
  });

  it('returns host content without exposing host paths or repository data', () => {
    expect(
      attachmentOpenResponseText({
        taskId: 'attachment-open-1',
        ok: true,
        data: { content: 'attachment body' },
      }),
    ).toBe('attachment body');
  });

  it('returns honest copy for missing, rejected, or malformed host responses', () => {
    expect(attachmentOpenResponseText(null)).toContain(
      "can't get that file from the channel",
    );
    expect(
      attachmentOpenResponseText({
        taskId: 'attachment-open-1',
        ok: false,
        error: 'Attachment resolver is not ready.',
      }),
    ).toBe("I can't open that attachment: Attachment resolver is not ready.");
    expect(
      attachmentOpenResponseText({
        taskId: 'attachment-open-1',
        ok: true,
        data: { materializedPath: '/private/host-only/path' },
      }),
    ).toContain("can't get that file from the channel");
  });
});
