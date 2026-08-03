import { createAttachmentOpenProof } from '../../shared/attachment-open-auth-proof.js';

interface AttachmentOpenTaskResponse {
  ok: boolean;
  error?: string;
  data?: unknown;
}

const DEFAULT_BATCH_CONCURRENCY = 4;
const MAX_BATCH_ITEM_BYTES = 32_000;
const MAX_BATCH_OUTPUT_BYTES = 160_000;
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

export function attachmentOpenResponseText(
  response: AttachmentOpenTaskResponse | null,
): string {
  if (!response) {
    return "I can't get that file from the channel right now.";
  }
  if (!response.ok) {
    return `I can't open that attachment: ${
      response.error || 'the host rejected the request.'
    }`;
  }
  const data =
    response.data &&
    typeof response.data === 'object' &&
    !Array.isArray(response.data)
      ? (response.data as Record<string, unknown>)
      : {};
  return typeof data.content === 'string'
    ? data.content
    : "I can't get that file from the channel right now.";
}

export async function openAttachmentBatch(
  attachmentIds: readonly string[],
  openAttachment: (attachmentId: string) => Promise<string>,
  concurrency = DEFAULT_BATCH_CONCURRENCY,
): Promise<string> {
  const results = new Array<string>(attachmentIds.length);
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
        results[index] = boundedUtf8(
          await openAttachment(attachmentId),
          MAX_BATCH_ITEM_BYTES,
        );
      }
    }),
  );
  const combined = results
    .map(
      (content, index) =>
        `Attachment ${index + 1} (gantry_attachment=${attachmentIds[index]}):\n${content}`,
    )
    .join('\n\n');
  return boundedUtf8(combined, MAX_BATCH_OUTPUT_BYTES);
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
