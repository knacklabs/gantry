import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  ATTACHMENT_IPC_AUTH_TOKEN,
  chatJid,
  TASKS_DIR,
  threadId,
} from '../context.js';
import { makeIpcId } from '../ipc-ids.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import {
  attachmentOpenResponseText,
  attachmentOpenTaskRequest,
  openAttachmentBatch,
} from '../attachment-open-protocol.js';

export {
  attachmentOpenResponseText,
  attachmentOpenTaskRequest,
} from '../attachment-open-protocol.js';

const ATTACHMENT_OPEN_TASK_TIMEOUT_MS = 120_000;
const MAX_ATTACHMENT_BATCH_SIZE = 12;

export function registerAttachmentTools(server: McpServer): void {
  server.tool(
    'attachment_open',
    'Read inbound conversation attachments using their opaque gantry_attachment ids. Always use this for attachment metadata; never use FileRead or FileSearch on gantry_ref paths. Pass attachment_ids to read multiple files concurrently in one call. The host verifies conversation scope and returns bounded extracted text for documents.',
    {
      // Batch-only by design: this repo ships runner+host+prompts atomically
      // and keeps no backward-compatible aliases (decision: no-legacy policy).
      attachment_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_ATTACHMENT_BATCH_SIZE)
        .describe(
          'Opaque gantry_attachment ids to read concurrently, in source order. Pass one id to read a single attachment.',
        ),
    },
    async ({ attachment_ids }) => {
      const ids = attachment_ids
        .map((value) => value.trim())
        .filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index);
      const text =
        ids.length === 0
          ? 'No gantry_attachment id was provided.'
          : ids.length === 1
            ? await requestHostAttachmentOpen(ids[0]!)
            : await openAttachmentBatch(ids, requestHostAttachmentOpen);
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}

export async function requestHostAttachmentOpen(
  attachmentId: string,
): Promise<string> {
  const taskId = makeIpcId('attachment-open');
  writeIpcFile(
    TASKS_DIR,
    attachmentOpenTaskRequest({
      attachmentId,
      chatJid,
      threadId,
      taskId,
      authToken: ATTACHMENT_IPC_AUTH_TOKEN,
    }),
  );
  const response = await waitForTaskResponse(
    taskId,
    ATTACHMENT_OPEN_TASK_TIMEOUT_MS,
  );
  return attachmentOpenResponseText(response);
}
