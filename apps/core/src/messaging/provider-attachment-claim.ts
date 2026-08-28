import { createHmac, randomUUID } from 'node:crypto';

export interface ProviderAttachmentClaimInput {
  senderId: string;
  fileId: string;
  conversationId: string;
  now?: number;
  nonce?: string;
}

export function createProviderAttachmentClaim(
  secret: string,
  input: ProviderAttachmentClaimInput,
): string {
  const issuedAt = input.now ?? Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      sub: input.senderId,
      file: input.fileId,
      conversation: input.conversationId,
      jti: input.nonce ?? randomUUID(),
      iat: issuedAt,
      exp: issuedAt + 300,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}
