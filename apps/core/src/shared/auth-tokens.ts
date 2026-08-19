import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const AUTH_TOKEN_BYTES = 32;

export function createOpaqueToken(): string {
  return randomBytes(AUTH_TOKEN_BYTES).toString('base64url');
}

export function createAccessReference(): string {
  return `GNT-${randomBytes(5).toString('hex').toUpperCase()}`;
}

export function hashAuthToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function matchesAuthToken(token: string, tokenHash: string): boolean {
  const expected = Buffer.from(tokenHash, 'hex');
  const actual = createHash('sha256').update(token).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
