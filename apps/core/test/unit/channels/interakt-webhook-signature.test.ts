import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyInteraktSignature } from '@core/channels/interakt/interakt-webhook-signature.js';

const SECRET = 'super_secret_for_tests';

function signLowercase(body: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyInteraktSignature', () => {
  it('accepts a correctly-signed body', () => {
    const body = Buffer.from('{"type":"message_received","data":{}}', 'utf8');
    const hex = signLowercase(body, SECRET);
    expect(verifyInteraktSignature(body, `sha256=${hex}`, SECRET)).toBe(true);
  });

  it('accepts upper-case hex', () => {
    const body = Buffer.from('payload', 'utf8');
    const hex = signLowercase(body, SECRET).toUpperCase();
    expect(verifyInteraktSignature(body, `sha256=${hex}`, SECRET)).toBe(true);
  });

  it('rejects when the body bytes differ by whitespace', () => {
    const body = Buffer.from('{"type":"x"}', 'utf8');
    const hex = signLowercase(body, SECRET);
    const tampered = Buffer.from('{"type":"x"} ', 'utf8'); // trailing space
    expect(verifyInteraktSignature(tampered, `sha256=${hex}`, SECRET)).toBe(
      false,
    );
  });

  it('rejects when prefix is missing', () => {
    const body = Buffer.from('payload', 'utf8');
    const hex = signLowercase(body, SECRET);
    expect(verifyInteraktSignature(body, hex, SECRET)).toBe(false);
  });

  it('rejects when header is undefined', () => {
    const body = Buffer.from('payload', 'utf8');
    expect(verifyInteraktSignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects on length mismatch without throwing', () => {
    const body = Buffer.from('payload', 'utf8');
    expect(verifyInteraktSignature(body, 'sha256=abc', SECRET)).toBe(false);
  });

  it('rejects when secret is empty', () => {
    const body = Buffer.from('payload', 'utf8');
    const hex = signLowercase(body, SECRET);
    expect(verifyInteraktSignature(body, `sha256=${hex}`, '')).toBe(false);
  });

  it('rejects non-hex characters in signature', () => {
    const body = Buffer.from('payload', 'utf8');
    expect(verifyInteraktSignature(body, 'sha256=zzzz', SECRET)).toBe(false);
  });

  it('verifies an empty body when signed', () => {
    const body = Buffer.alloc(0);
    const hex = signLowercase(body, SECRET);
    expect(verifyInteraktSignature(body, `sha256=${hex}`, SECRET)).toBe(true);
  });
});
