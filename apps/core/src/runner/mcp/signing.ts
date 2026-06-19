import { createHmac, randomUUID, verify as cryptoVerify } from 'crypto';
import { nowMs as currentTimeMs, toIso } from '../../shared/time/datetime.js';
import { canonicalJson } from '../../shared/canonical-json.js';

export function signIpcRequestPayload(
  requestSigningKey: string | undefined,
  payload: Record<string, unknown>,
): string | undefined {
  const key = requestSigningKey?.trim();
  if (!key) return undefined;
  return createHmac('sha256', key).update(canonicalJson(payload)).digest('hex');
}

export function createSignedIpcRequestEnvelope(
  requestSigningKey: string | undefined,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const expiresAt =
    typeof payload.expiresAt === 'string' && payload.expiresAt.trim()
      ? payload.expiresAt
      : toIso(currentTimeMs() + 5 * 60_000);
  const signedPayload = {
    ...payload,
    requestId:
      typeof payload.requestId === 'string' && payload.requestId.trim()
        ? payload.requestId
        : `ipc-${randomUUID()}`,
    nonce: randomUUID(),
    expiresAt,
  };
  const signature = signIpcRequestPayload(requestSigningKey, signedPayload);
  return signature ? { ...signedPayload, signature } : signedPayload;
}

export function verifyIpcResponsePayload(
  publicKeyPem: string | undefined,
  payload: Record<string, unknown>,
  signature: string | undefined,
): boolean {
  const key = publicKeyPem?.trim();
  const sig = signature?.trim();
  if (!sig) return false;
  if (!key) return false;
  try {
    return cryptoVerify(
      null,
      Buffer.from(JSON.stringify(payload)),
      key,
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return false;
  }
}
