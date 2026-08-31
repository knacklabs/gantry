import { createHash, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { nowMs } from './datetime.js';

export interface IngressSignaturePayloadInput {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}

export function buildIngressSignaturePayload(
  input: IngressSignaturePayloadInput,
): {
  canonicalPayload: string;
  bodyHash: string;
} {
  const method = input.method.trim().toUpperCase();
  const path = input.path.trim();
  const timestamp = input.timestamp.trim();
  const nonce = input.nonce.trim();
  const body = input.rawBody;
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return {
    canonicalPayload: [method, path, timestamp, nonce, bodyHash, body].join(
      '\n',
    ),
    bodyHash,
  };
}

export function signIngressRequestEd25519(input: {
  privateKeyPem: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  const { canonicalPayload } = buildIngressSignaturePayload(input);
  return cryptoSign(
    null,
    Buffer.from(canonicalPayload, 'utf8'),
    input.privateKeyPem,
  ).toString('base64');
}

export function verifyIngressSignatureEd25519(input: {
  publicKeyPem: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
  signature: string;
  toleranceMs?: number;
  nowMs?: number;
}): boolean {
  const timestampMs = Number(input.timestamp);
  const toleranceMs = input.toleranceMs ?? 5 * 60_000;
  if (
    !Number.isFinite(timestampMs) ||
    (toleranceMs >= 0 &&
      Math.abs((input.nowMs ?? nowMs()) - timestampMs) > toleranceMs)
  ) {
    return false;
  }
  const { canonicalPayload } = buildIngressSignaturePayload(input);
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalPayload, 'utf8'),
      input.publicKeyPem,
      Buffer.from(input.signature, 'base64'),
    );
  } catch {
    return false;
  }
}
