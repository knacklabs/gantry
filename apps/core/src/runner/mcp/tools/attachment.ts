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
} from '../attachment-open-protocol.js';

export {
  attachmentOpenResponseText,
  attachmentOpenTaskRequest,
} from '../attachment-open-protocol.js';

const ATTACHMENT_OPEN_TASK_TIMEOUT_MS = 120_000;

export function registerAttachmentTools(server: McpServer): void {
  server.tool(
    'attachment_open',
    'Open one durable conversation attachment by its opaque gantry_attachment id. The host verifies conversation scope before returning bounded content.',
    {
      attachment_id: z
        .string()
        .min(1)
        .describe('Opaque id from the attachment gantry_attachment attribute.'),
    },
    async ({ attachment_id }) => ({
      content: [
        {
          type: 'text' as const,
          text: await requestHostAttachmentOpen(attachment_id),
        },
      ],
    }),
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
