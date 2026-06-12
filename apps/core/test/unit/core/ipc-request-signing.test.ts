import { describe, expect, it } from 'vitest';

import {
  signIpcRequestPayload,
  validateIpcRequestFreshness,
  verifyIpcRequestPayload,
} from '@core/infrastructure/ipc/request-signing.js';

describe('ipc request signing', () => {
  it('verifies signed payloads and rejects tampering', () => {
    const payload = {
      requestId: 'req-1',
      nonce: '123e4567-e89b-12d3-a456-426614174000',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      action: 'send',
    };
    const signature = signIpcRequestPayload('key', payload);

    expect(verifyIpcRequestPayload('key', payload, signature)).toBe(true);
    expect(
      verifyIpcRequestPayload(
        'key',
        { ...payload, action: 'replay' },
        signature,
      ),
    ).toBe(false);
  });

  it('uses deterministic canonical key ordering for request signatures', () => {
    const left = {
      requestId: 'ipc-ordered',
      nonce: '14580ec7-3383-4d18-bc44-47cd8c7f401d',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nested: { b: 2, a: 1 },
    };
    const right = {
      nested: { a: 1, b: 2 },
      expiresAt: left.expiresAt,
      nonce: left.nonce,
      requestId: left.requestId,
    };
    const signature = signIpcRequestPayload('key', left);

    expect(signature).toBe(signIpcRequestPayload('key', right));
    expect(verifyIpcRequestPayload('key', right, signature)).toBe(true);
  });

  it('requires nonce and bounded expiry metadata', () => {
    const now = Date.parse('2026-04-24T00:00:00.000Z');

    expect(
      validateIpcRequestFreshness(
        {
          requestId: 'req-1',
          nonce: '123e4567-e89b-12d3-a456-426614174000',
          expiresAt: '2026-04-24T00:01:00.000Z',
        },
        now,
      ),
    ).toEqual({ ok: true });
    expect(
      validateIpcRequestFreshness(
        {
          requestId: 'req-1',
          nonce: '123e4567-e89b-12d3-a456-426614174000',
          expiresAt: '2026-04-24T00:10:00.000Z',
        },
        now,
      ),
    ).toEqual({ ok: false, reason: 'expiresAt exceeds max age' });
    expect(
      validateIpcRequestFreshness(
        {
          nonce: '123e4567-e89b-12d3-a456-426614174000',
          expiresAt: '2026-04-24T00:01:00.000Z',
        },
        now,
      ),
    ).toEqual({ ok: false, reason: 'missing or invalid requestId' });
    expect(
      validateIpcRequestFreshness(
        {
          requestId: 'req-1',
          nonce: 'bad',
          expiresAt: '2026-04-24T00:01:00.000Z',
        },
        now,
      ),
    ).toEqual({ ok: false, reason: 'missing or invalid nonce' });
  });
});
