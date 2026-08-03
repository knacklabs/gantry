import { describe, expect, it } from 'vitest';

import {
  attachmentOpenResponseText,
  attachmentOpenTaskRequest,
  openAttachmentBatch,
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

  it('opens attachment batches concurrently while preserving source order', async () => {
    let active = 0;
    let peak = 0;
    const result = await openAttachmentBatch(
      ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
      async (attachmentId) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return `content-${attachmentId}`;
      },
      3,
    );

    expect(peak).toBe(3);
    expect(result.match(/Attachment \d/g)).toHaveLength(6);
    expect(result.indexOf('content-a1')).toBeLessThan(
      result.indexOf('content-a6'),
    );
  });

  it('bounds each item and the combined batch response', async () => {
    const result = await openAttachmentBatch(
      Array.from({ length: 8 }, (_, index) => `file-${index}`),
      async () => 'x'.repeat(100_000),
    );

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(160_000);
    expect(result).toContain('[Attachment content truncated.]');
  });
});
