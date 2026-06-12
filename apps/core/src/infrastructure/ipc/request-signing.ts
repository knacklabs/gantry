import { createHmac, timingSafeEqual } from 'crypto';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
import { canonicalJson } from '../../shared/canonical-json.js';

export const IPC_REQUEST_MAX_AGE_MS = 5 * 60_000;

export function signIpcRequestPayload(
  requestSigningKey: string | undefined,
  payload: Record<string, unknown>,
): string | undefined {
  const key = requestSigningKey?.trim();
  if (!key) return undefined;
  return createHmac('sha256', key).update(canonicalJson(payload)).digest('hex');
}

export function verifyIpcRequestPayload(
  requestSigningKey: string | undefined,
  payload: Record<string, unknown>,
  signature: string | undefined,
): boolean {
  const key = requestSigningKey?.trim();
  const sig = signature?.trim();
  if (!key || !sig) return false;
  const expected = signIpcRequestPayload(key, payload);
  if (!expected || sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function validateIpcRequestFreshness(
  payload: Record<string, unknown>,
  nowMs = currentTimeMs(),
): { ok: true } | { ok: false; reason: string } {
  const requestId =
    typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(requestId)) {
    return { ok: false, reason: 'missing or invalid requestId' };
  }

  const nonce = typeof payload.nonce === 'string' ? payload.nonce.trim() : '';
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      nonce,
    )
  ) {
    return { ok: false, reason: 'missing or invalid nonce' };
  }

  const expiresAtRaw =
    typeof payload.expiresAt === 'string' ? payload.expiresAt.trim() : '';
  const expiresAtMs = Date.parse(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: 'missing or invalid expiresAt' };
  }
  if (expiresAtMs < nowMs) {
    return { ok: false, reason: 'expired request' };
  }
  if (expiresAtMs - nowMs > IPC_REQUEST_MAX_AGE_MS) {
    return { ok: false, reason: 'expiresAt exceeds max age' };
  }
  return { ok: true };
}
