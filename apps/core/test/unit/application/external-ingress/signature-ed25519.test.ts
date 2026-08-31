import { describe, expect, it } from 'vitest';
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';

import {
  signExternalIngressEd25519Request,
  verifyExternalIngressEd25519Signature,
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
  ed25519Verify: (
    publicKeyPem: string,
    payload: string,
    signatureBase64: string,
  ) => {
    try {
      return cryptoVerify(
        null,
        Buffer.from(payload, 'utf8'),
        publicKeyPem,
        Buffer.from(signatureBase64, 'base64'),
      );
    } catch {
      return false;
    }
  },
};

function generateTestKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKeyPem: privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
  };
}

describe('external ingress Ed25519 signature helpers', () => {
  it('accepts a valid Ed25519 signature', () => {
    const { publicKeyPem, privateKeyPem } = generateTestKeyPair();
    const timestamp = String(Date.now());
    const rawBody = JSON.stringify({ target: { kind: 'session_message', message: 'hello' } });

    const { signature } = signExternalIngressEd25519Request({
      crypto: cryptoPort,
      privateKeySign: (key, payload) =>
        cryptoSign(null, Buffer.from(payload, 'utf8'), key).toString('base64'),
      privateKeyPem,
      method: 'POST',
      path: '/v1/ingresses/ing-1/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody,
    });

    const isValid = verifyExternalIngressEd25519Signature({
      crypto: cryptoPort,
      publicKeyPem,
      method: 'POST',
      path: '/v1/ingresses/ing-1/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody,
      signature,
      nowMs: Date.now(),
    });

    expect(isValid).toBe(true);
  });

  it('rejects an Ed25519 signature with tampered body', () => {
    const { publicKeyPem, privateKeyPem } = generateTestKeyPair();
    const timestamp = String(Date.now());
    const rawBody = JSON.stringify({ target: { kind: 'session_message', message: 'hello' } });

    const { signature } = signExternalIngressEd25519Request({
      crypto: cryptoPort,
      privateKeySign: (key, payload) =>
        cryptoSign(null, Buffer.from(payload, 'utf8'), key).toString('base64'),
      privateKeyPem,
      method: 'POST',
      path: '/v1/ingresses/ing-1/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody,
    });

    const isValid = verifyExternalIngressEd25519Signature({
      crypto: cryptoPort,
      publicKeyPem,
      method: 'POST',
      path: '/v1/ingresses/ing-1/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody: JSON.stringify({ target: { kind: 'session_message', message: 'tampered' } }),
      signature,
      nowMs: Date.now(),
    });

    expect(isValid).toBe(false);
  });

  it('rejects an Ed25519 signature with a stale timestamp', () => {
    const { publicKeyPem, privateKeyPem } = generateTestKeyPair();
    const staleTimestamp = String(Date.now() - 10 * 60_000);
    const rawBody = '{}';

    const { signature } = signExternalIngressEd25519Request({
      crypto: cryptoPort,
      privateKeySign: (key, payload) =>
        cryptoSign(null, Buffer.from(payload, 'utf8'), key).toString('base64'),
      privateKeyPem,
      method: 'POST',
      path: '/v1/ingresses/ing-1/invoke',
      timestamp: staleTimestamp,
      nonce: 'nonce-1',
      rawBody,
    });

    const isValid = verifyExternalIngressEd25519Signature({
      crypto: cryptoPort,
      publicKeyPem,
      method: 'POST',
      path: '/v1/ingresses/ing-1/invoke',
      timestamp: staleTimestamp,
      nonce: 'nonce-1',
      rawBody,
      signature,
      nowMs: Date.now(),
    });

    expect(isValid).toBe(false);
  });

  it('rejects signature verified with wrong public key', () => {
    const keyPair1 = generateTestKeyPair();
    const keyPair2 = generateTestKeyPair();
    const timestamp = String(Date.now());
    const rawBody = '{}';

    const { signature } = signExternalIngressEd25519Request({
      crypto: cryptoPort,
      privateKeySign: (key, payload) =>
        cryptoSign(null, Buffer.from(payload, 'utf8'), key).toString('base64'),
      privateKeyPem: keyPair1.privateKeyPem,
      method: 'POST',
      path: '/v1/ingresses/ing-1/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody,
    });

    const isValid = verifyExternalIngressEd25519Signature({
      crypto: cryptoPort,
      publicKeyPem: keyPair2.publicKeyPem,
      method: 'POST',
      path: '/v1/ingresses/ing-1/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody,
      signature,
      nowMs: Date.now(),
    });

    expect(isValid).toBe(false);
  });
});
