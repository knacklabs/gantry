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
  attachmentOpenResponsePayload,
  attachmentOpenTaskRequest,
  openAttachmentBatch,
  type AttachmentOpenImagePayload,
  type AttachmentOpenPayload,
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
      // When the image block is actually delivered, the host's switch-agent
      // guidance would contradict it; substitute neutral text up front.
      const openPayload = async (attachmentId: string) => {
        const payload = await requestHostAttachmentOpenPayload(attachmentId);
        return payload.image && modelSupportsImageInput()
          ? {
              ...payload,
              text: 'Image attachment: delivered as an image block in this result.',
            }
          : payload;
      };
      const { text, images } =
        ids.length === 0
          ? { text: 'No gantry_attachment id was provided.', images: [] }
          : ids.length === 1
            ? singleAttachmentResult(await openPayload(ids[0]!))
            : await openAttachmentBatch(ids, openPayload);
      // Image payloads reach the model only when its declared input
      // modalities include images; otherwise the host's guidance text (which
      // already points at vision-capable agents) stands alone.
      const deliverableImages = modelSupportsImageInput() ? images : [];
      return {
        content: [
          { type: 'text' as const, text },
          ...deliverableImages.map((image) => ({
            type: 'image' as const,
            data: image.base64,
            mimeType: image.mimeType,
          })),
        ],
      };
    },
  );
}

function modelSupportsImageInput(): boolean {
  return (process.env.GANTRY_MODEL_INPUT_MODALITIES ?? '')
    .split(',')
    .includes('image');
}

function singleAttachmentResult(payload: AttachmentOpenPayload): {
  text: string;
  images: AttachmentOpenImagePayload[];
} {
  return { text: payload.text, images: payload.image ? [payload.image] : [] };
}

export async function requestHostAttachmentOpenPayload(
  attachmentId: string,
): Promise<AttachmentOpenPayload> {
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
  return attachmentOpenResponsePayload(response);
}
