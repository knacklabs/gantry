import { createAttachmentOpenProof } from '../../shared/attachment-open-auth-proof.js';

interface AttachmentOpenTaskResponse {
  ok: boolean;
  error?: string;
  data?: unknown;
}

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
