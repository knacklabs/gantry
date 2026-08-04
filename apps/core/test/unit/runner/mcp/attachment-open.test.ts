import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attachmentOpenResponsePayload,
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

  it('preserves well-shaped image payloads and drops malformed ones', () => {
    expect(
      attachmentOpenResponsePayload({
        ok: true,
        data: {
          content: 'ERROR: screenshot.png is an image.',
          image: { base64: 'aGk=', mimeType: 'image/png' },
        },
      }),
    ).toEqual({
      text: 'ERROR: screenshot.png is an image.',
      image: { base64: 'aGk=', mimeType: 'image/png' },
    });
    expect(
      attachmentOpenResponsePayload({
        ok: true,
        data: { content: 'body', image: { base64: 42 } },
      }),
    ).toEqual({ text: 'body' });
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
        return { text: `content-${attachmentId}` };
      },
      { concurrency: 3 },
    );

    expect(peak).toBe(3);
    expect(result.text.match(/Attachment \d/g)).toHaveLength(6);
    expect(result.text.indexOf('content-a1')).toBeLessThan(
      result.text.indexOf('content-a6'),
    );
    expect(result.images).toEqual([]);
  });

  it('bounds each item and the combined batch response', async () => {
    const result = await openAttachmentBatch(
      Array.from({ length: 8 }, (_, index) => `file-${index}`),
      async () => ({ text: 'x'.repeat(100_000) }),
    );

    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(160_000);
    expect(result.text).toContain('[Attachment content truncated.]');
  });

  it('caps batch image payloads at four in source order', async () => {
    const result = await openAttachmentBatch(
      ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'],
      async (attachmentId) => ({
        text: `guidance-${attachmentId}`,
        image: { base64: `data-${attachmentId}`, mimeType: 'image/png' },
      }),
      { deliverImages: true },
    );

    expect(result.images.map((image) => image.base64)).toEqual([
      'data-i1',
      'data-i2',
      'data-i3',
      'data-i4',
    ]);
    expect(result.text.match(/\[image omitted: 4-image limit\]/g)).toHaveLength(
      2,
    );
  });
});

describe('attachment_open tool image delivery', () => {
  const previousEnv = {
    GANTRY_IPC_DIR: process.env.GANTRY_IPC_DIR,
    GANTRY_MODEL_INPUT_MODALITIES: process.env.GANTRY_MODEL_INPUT_MODALITIES,
  };
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@core/runner/mcp/ipc.js');
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  async function callTool(
    responsesByAttachmentId: Record<string, unknown>,
    attachmentIds: string[],
  ): Promise<{
    content: Array<{ type: string; text?: string; data?: string }>;
  }> {
    vi.resetModules();
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-attach-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
    const attachmentIdByTaskId = new Map<string, string>();
    vi.doMock('@core/runner/mcp/ipc.js', () => ({
      writeIpcFile: vi.fn(
        (
          _dir: string,
          task: { taskId: string; payload: { attachmentId: string } },
        ) => {
          attachmentIdByTaskId.set(task.taskId, task.payload.attachmentId);
        },
      ),
      waitForTaskResponse: vi.fn(async (taskId: string) => ({
        ok: true,
        data: responsesByAttachmentId[attachmentIdByTaskId.get(taskId)!],
      })),
    }));
    const { registerAttachmentTools } =
      await import('@core/runner/mcp/tools/attachment.js');
    let handler:
      | ((args: { attachment_ids: string[] }) => Promise<{
          content: Array<{ type: string; text?: string; data?: string }>;
        }>)
      | undefined;
    registerAttachmentTools({
      tool: (
        _name: string,
        _description: string,
        _schema: unknown,
        toolHandler: never,
      ) => {
        handler = toolHandler;
      },
    } as never);
    return handler!({ attachment_ids: attachmentIds });
  }

  const imageResponse = (name: string) => ({
    content: `ERROR: ${name} is an image.`,
    image: { base64: `bytes-${name}`, mimeType: 'image/png' },
  });

  it('appends image blocks when the model declares image input', async () => {
    process.env.GANTRY_MODEL_INPUT_MODALITIES = 'image,image-tool-results,pdf';

    const result = await callTool({ a1: imageResponse('a1') }, ['a1']);

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Image attachment: delivered as an image block in this result.',
      },
      { type: 'image', data: 'bytes-a1', mimeType: 'image/png' },
    ]);
  });

  it('returns guidance text only when the model lacks image input', async () => {
    delete process.env.GANTRY_MODEL_INPUT_MODALITIES;

    const result = await callTool({ a1: imageResponse('a1') }, ['a1']);

    expect(result.content).toEqual([
      { type: 'text', text: 'ERROR: a1 is an image.' },
    ]);
  });

  it('caps a batch call at four image blocks', async () => {
    process.env.GANTRY_MODEL_INPUT_MODALITIES = 'image,image-tool-results';
    const ids = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];

    const result = await callTool(
      Object.fromEntries(ids.map((id) => [id, imageResponse(id)])),
      ids,
    );

    expect(
      result.content.filter((block) => block.type === 'image'),
    ).toHaveLength(4);
    expect(result.content[0]?.text).toContain('[image omitted: 4-image limit]');
  });
});
