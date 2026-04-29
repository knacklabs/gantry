import {
  createHmac,
  randomUUID,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'crypto';

export function signIpcRequestPayload(
  requestSigningKey: string | undefined,
  payload: Record<string, unknown>,
): string | undefined {
  const key = requestSigningKey?.trim();
  if (!key) return undefined;
  return createHmac('sha256', key)
    .update(JSON.stringify(payload))
    .digest('hex');
}

export function createSignedIpcRequestEnvelope(
  requestSigningKey: string | undefined,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const signedPayload = {
    ...payload,
    requestId:
      typeof payload.requestId === 'string' && payload.requestId.trim()
        ? payload.requestId
        : `ipc-${randomUUID()}`,
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  const signature = signIpcRequestPayload(requestSigningKey, signedPayload);
  return signature ? { ...signedPayload, signature } : signedPayload;
}

export function verifyIpcResponsePayload(
  publicKeyPem: string | undefined,
  responseSigningKey: string | undefined,
  payload: Record<string, unknown>,
  signature: string | undefined,
): boolean {
  const key = publicKeyPem?.trim();
  const sig = signature?.trim();
  if (!sig) return false;
  if (key) {
    try {
      if (
        cryptoVerify(
          null,
          Buffer.from(JSON.stringify(payload)),
          key,
          Buffer.from(sig, 'base64'),
        )
      ) {
        return true;
      }
    } catch {
      // Fall through to deterministic IPC auth response signatures.
    }
  }
  const hmacKey = responseSigningKey?.trim();
  if (!hmacKey) return false;
  const expected = createHmac('sha256', hmacKey)
    .update(Buffer.from(JSON.stringify(payload)))
    .digest('hex');
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
