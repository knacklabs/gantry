import { createAttachmentOpenProof } from '../../shared/attachment-open-auth-proof.js';

interface AttachmentOpenTaskResponse {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface AttachmentOpenImagePayload {
  base64: string;
  mimeType: string;
}

export interface AttachmentOpenPayload {
  text: string;
  image?: AttachmentOpenImagePayload;
}

const DEFAULT_BATCH_CONCURRENCY = 4;
const MAX_BATCH_ITEM_BYTES = 32_000;
const MAX_BATCH_OUTPUT_BYTES = 160_000;
export const MAX_IMAGE_BLOCKS_PER_CALL = 4;
const IMAGE_LIMIT_NOTE = '[image omitted: 4-image limit]';
export const DELIVERED_IMAGE_TEXT =
  'Image attachment: delivered as an image block in this result.';
const TRUNCATION_SUFFIX = '\n[Attachment content truncated.]';

export function attachmentOpenTaskRequest(input: {
  attachmentId: string;
  chatJid: string;
  threadId?: string;
  taskId: string;
  authToken: string;
}) {
  return {
    type: 'attachment_open',
    taskId: input.taskId,
    chatJid: input.chatJid,
    targetJid: input.chatJid,
    payload: {
      attachmentId: input.attachmentId,
      conversationProof: createAttachmentOpenProof(input.authToken, {
        attachmentId: input.attachmentId,
        chatJid: input.chatJid,
        taskId: input.taskId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      }),
    },
  };
}

export function attachmentOpenResponsePayload(
  response: AttachmentOpenTaskResponse | null,
): AttachmentOpenPayload {
  if (!response) {
    return { text: "I can't get that file from the channel right now." };
  }
  if (!response.ok) {
    return {
      text: `I can't open that attachment: ${
        response.error || 'the host rejected the request.'
      }`,
    };
  }
  const data =
    response.data &&
    typeof response.data === 'object' &&
    !Array.isArray(response.data)
      ? (response.data as Record<string, unknown>)
      : {};
  if (typeof data.content !== 'string') {
    return { text: "I can't get that file from the channel right now." };
  }
  const image =
    data.image &&
    typeof data.image === 'object' &&
    !Array.isArray(data.image) &&
    typeof (data.image as Record<string, unknown>).base64 === 'string' &&
    typeof (data.image as Record<string, unknown>).mimeType === 'string'
      ? {
          base64: (data.image as Record<string, string>).base64,
          mimeType: (data.image as Record<string, string>).mimeType,
        }
      : undefined;
  return { text: data.content, ...(image ? { image } : {}) };
}

export function attachmentOpenResponseText(
  response: AttachmentOpenTaskResponse | null,
): string {
  return attachmentOpenResponsePayload(response).text;
}

export async function openAttachmentBatch(
  attachmentIds: readonly string[],
  openAttachment: (attachmentId: string) => Promise<AttachmentOpenPayload>,
  options?: { deliverImages?: boolean; concurrency?: number },
): Promise<{ text: string; images: AttachmentOpenImagePayload[] }> {
  const concurrency = options?.concurrency ?? DEFAULT_BATCH_CONCURRENCY;
  const results = new Array<AttachmentOpenPayload>(attachmentIds.length);
  // Split the combined budget across every requested id so late attachments
  // cannot be truncated out of the response entirely.
  const perItemBudget = Math.min(
    MAX_BATCH_ITEM_BYTES,
    Math.max(
      2_000,
      Math.floor(MAX_BATCH_OUTPUT_BYTES / attachmentIds.length) - 120,
    ),
  );
  let nextIndex = 0;
  const workerCount = Math.min(
    attachmentIds.length,
    Math.max(1, Math.floor(concurrency)),
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < attachmentIds.length) {
        const index = nextIndex++;
        const attachmentId = attachmentIds[index]!;
        // One failed attachment must not discard the others' reads.
        const payload = await openAttachment(attachmentId).catch(
          (): AttachmentOpenPayload => ({
            text: 'ERROR: this attachment could not be read.',
          }),
        );
        results[index] = {
          ...payload,
          text: boundedUtf8(payload.text, perItemBudget),
        };
      }
    }),
  );
  // Cap image payloads per call in source order. Text is decided HERE, where
  // delivery is known: a retained image gets neutral delivered-text, an
  // omitted one keeps the host's actionable guidance plus the omission note.
  const images: AttachmentOpenImagePayload[] = [];
  const combined = results
    .map((payload, index) => {
      let text = payload.text;
      if (payload.image && options?.deliverImages) {
        if (images.length < MAX_IMAGE_BLOCKS_PER_CALL) {
          images.push(payload.image);
          text = DELIVERED_IMAGE_TEXT;
        } else {
          text = `${text}\n${IMAGE_LIMIT_NOTE}`;
        }
      }
      return `Attachment ${index + 1} (gantry_attachment=${attachmentIds[index]}):\n${text}`;
    })
    .join('\n\n');
  return { text: boundedUtf8(combined, MAX_BATCH_OUTPUT_BYTES), images };
}

function boundedUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return value;
  const suffix = Buffer.from(TRUNCATION_SUFFIX, 'utf8');
  const contentLimit = Math.max(0, maxBytes - suffix.byteLength);
  return `${encoded
    .subarray(0, contentLimit)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}${TRUNCATION_SUFFIX}`;
}
