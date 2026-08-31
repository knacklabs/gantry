import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';

export interface ExternalIngressSignaturePort {
  sha256(input: string): string;
  constantTimeEqual(left: string, right: string): boolean;
  ed25519Verify(
    publicKeyPem: string,
    payload: string,
    signatureBase64: string,
  ): boolean;
}

export interface ExternalIngressSignaturePayloadInput {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
  bodyHash: string;
}

export function buildExternalIngressSignaturePayload(
  input: ExternalIngressSignaturePayloadInput,
): string {
  return [
    input.method.trim().toUpperCase(),
    input.path.trim(),
    input.timestamp.trim(),
    input.nonce.trim(),
    input.bodyHash,
    input.rawBody,
  ].join('\n');
}

export function isExternalIngressTimestampFresh(input: {
  timestamp: string;
  toleranceMs?: number;
  nowMs?: number;
}): boolean {
  const timestampMs = Number(input.timestamp);
  const toleranceMs = input.toleranceMs ?? 5 * 60_000;
  if (!Number.isFinite(timestampMs)) return false;
  return (
    toleranceMs < 0 ||
    Math.abs((input.nowMs ?? currentTimeMs()) - timestampMs) <= toleranceMs
  );
}

export function signExternalIngressEd25519Request(input: {
  crypto: ExternalIngressSignaturePort;
  privateKeySign: (privateKeyPem: string, payload: string) => string;
  privateKeyPem: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): { signature: string; bodyHash: string; payload: string } {
  const bodyHash = input.crypto.sha256(input.rawBody);
  const payload = buildExternalIngressSignaturePayload({
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    rawBody: input.rawBody,
    bodyHash,
  });
  return {
    signature: input.privateKeySign(input.privateKeyPem, payload),
    bodyHash,
    payload,
  };
}

export function verifyExternalIngressEd25519Signature(input: {
  crypto: ExternalIngressSignaturePort;
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
  if (
    !isExternalIngressTimestampFresh({
      timestamp: input.timestamp,
      toleranceMs: input.toleranceMs,
      nowMs: input.nowMs,
    })
  ) {
    return false;
  }
  const bodyHash = input.crypto.sha256(input.rawBody);
  const payload = buildExternalIngressSignaturePayload({
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    rawBody: input.rawBody,
    bodyHash,
  });
  return input.crypto.ed25519Verify(
    input.publicKeyPem,
    payload,
    input.signature,
  );
}
