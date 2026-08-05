import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AttachmentOpenProofInput {
  type: 'attachment_open' | 'attachment_materialize';
  attachmentId: string;
  chatJid: string;
  taskId: string;
  threadId?: string;
}

export function createAttachmentOpenProof(
  authToken: string,
  input: AttachmentOpenProofInput,
): string {
  return createHmac('sha256', authToken)
    .update(
      [
        input.type,
        input.taskId,
        input.attachmentId,
        input.chatJid,
        input.threadId ?? '',
      ].join('\0'),
    )
    .digest('hex');
}

export function verifyAttachmentOpenProof(
  authToken: string,
  input: AttachmentOpenProofInput,
  candidate: string,
): boolean {
  if (!candidate) return false;
  const expected = createAttachmentOpenProof(authToken, input);
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}
