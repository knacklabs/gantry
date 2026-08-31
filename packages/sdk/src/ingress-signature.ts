import { createHash, createHmac, sign as cryptoSign, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';

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

export function signIngressSignaturePayload(input: {
  secret: string;
  payload: string;
}): string {
  return createHmac('sha256', input.secret).update(input.payload).digest('hex');
}

export function signIngressRequest(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  return signIngressSignaturePayload({
    secret: input.secret,
    payload: buildIngressSignaturePayload(input).canonicalPayload,
  });
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

export function verifyIngressSignature(input: {
  secret: string;
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

  const expected = signIngressRequest({
    secret: input.secret,
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    rawBody: input.rawBody,
  });
  const left = Buffer.from(expected);
  const right = Buffer.from(input.signature);
  return left.length === right.length && timingSafeEqual(left, right);
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
