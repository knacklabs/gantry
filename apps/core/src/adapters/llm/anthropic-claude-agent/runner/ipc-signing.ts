import { createHmac, randomUUID, verify as cryptoVerify } from 'crypto';
import { IPC_RESPONSE_VERIFY_KEY } from './runtime-env.js';
import { nowMs as currentTimeMs } from '../../../../shared/time/datetime.js';

export function hasValidIpcResponseSignature(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  if (!IPC_RESPONSE_VERIFY_KEY) return false;
  const signature =
    typeof raw.signature === 'string' ? raw.signature.trim() : '';
  return verifyIpcResponsePayload(IPC_RESPONSE_VERIFY_KEY, payload, signature);
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
    expiresAt: new Date(currentTimeMs() + 5 * 60_000).toISOString(),
  };
  const signature = signIpcRequestPayload(requestSigningKey, signedPayload);
  return signature ? { ...signedPayload, signature } : signedPayload;
}

function signIpcRequestPayload(
  requestSigningKey: string | undefined,
  payload: Record<string, unknown>,
): string | undefined {
  const key = requestSigningKey?.trim();
  if (!key) return undefined;
  return createHmac('sha256', key)
    .update(JSON.stringify(payload))
    .digest('hex');
}

function verifyIpcResponsePayload(
  publicKeyPem: string | undefined,
  payload: Record<string, unknown>,
  signature: string | undefined,
): boolean {
  const key = publicKeyPem?.trim();
  const sig = signature?.trim();
  if (!key || !sig) return false;
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
