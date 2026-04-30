import { describe, expect, it } from 'vitest';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  buildExternalIngressSignaturePayload,
  isExternalIngressTimestampFresh,
  signExternalIngressRequest,
  verifyExternalIngressRequestSignature,
} from '@core/application/external-ingress/signature.js';

const cryptoPort = {
  sha256: (input: string) => createHash('sha256').update(input).digest('hex'),
  hmacSha256: (secret: string, payload: string) =>
    createHmac('sha256', secret).update(payload).digest('hex'),
  constantTimeEqual: (left: string, right: string) => {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  },
};

describe('external ingress signature helpers', () => {
  it('accepts a valid signature', () => {
    const timestamp = String(Date.now());
    const signature = signExternalIngressRequest({
      crypto: cryptoPort,
      secret: 'secret',
      method: 'post',
      path: '/v1/external-ingress/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody: JSON.stringify({ ok: true }),
    }).signature;

    expect(
      verifyExternalIngressRequestSignature({
        crypto: cryptoPort,
        secret: 'secret',
        method: 'POST',
        path: '/v1/external-ingress/invoke',
        timestamp,
        nonce: 'nonce-1',
        rawBody: JSON.stringify({ ok: true }),
        signature,
        nowMs: Date.now(),
      }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const timestamp = String(Date.now());
    const signature = signExternalIngressRequest({
      crypto: cryptoPort,
      secret: 'secret',
      method: 'POST',
      path: '/v1/external-ingress/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody: JSON.stringify({ ok: true }),
    }).signature;

    expect(
      verifyExternalIngressRequestSignature({
        crypto: cryptoPort,
        secret: 'secret',
        method: 'POST',
        path: '/v1/external-ingress/invoke',
        timestamp,
        nonce: 'nonce-1',
        rawBody: JSON.stringify({ ok: false }),
        signature,
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });

  it('rejects stale timestamps', () => {
    const timestamp = String(Date.now() - 10 * 60_000);
    const signature = signExternalIngressRequest({
      crypto: cryptoPort,
      secret: 'secret',
      method: 'POST',
      path: '/v1/external-ingress/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody: '{}',
    }).signature;

    expect(
      verifyExternalIngressRequestSignature({
        crypto: cryptoPort,
        secret: 'secret',
        method: 'POST',
        path: '/v1/external-ingress/invoke',
        timestamp,
        nonce: 'nonce-1',
        rawBody: '{}',
        signature,
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });

  it('rejects non-numeric timestamps', () => {
    const signature = signExternalIngressRequest({
      crypto: cryptoPort,
      secret: 'secret',
      method: 'POST',
      path: '/v1/external-ingress/invoke',
      timestamp: 'not-a-number',
      nonce: 'nonce-1',
      rawBody: '{}',
    }).signature;

    expect(
      verifyExternalIngressRequestSignature({
        crypto: cryptoPort,
        secret: 'secret',
        method: 'POST',
        path: '/v1/external-ingress/invoke',
        timestamp: 'not-a-number',
        nonce: 'nonce-1',
        rawBody: '{}',
        signature,
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });

  it('canonicalizes method casing and emits a body hash', () => {
    const bodyHash = cryptoPort.sha256('{"ok":true}');
    const payload = buildExternalIngressSignaturePayload({
      method: 'post',
      path: '/v1/external-ingress/invoke',
      timestamp: '1700000000000',
      nonce: 'nonce-1',
      bodyHash,
      rawBody: '{"ok":true}',
    });

    expect(bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.startsWith('POST\n')).toBe(true);
  });

  it('validates timestamp freshness windows', () => {
    expect(
      isExternalIngressTimestampFresh({
        timestamp: '1700000000000',
        nowMs: 1700000001000,
        toleranceMs: 10_000,
      }),
    ).toBe(true);
    expect(
      isExternalIngressTimestampFresh({
        timestamp: '1700000000000',
        nowMs: 1700000020000,
        toleranceMs: 10_000,
      }),
    ).toBe(false);
  });
});
