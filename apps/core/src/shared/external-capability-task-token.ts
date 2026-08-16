import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { sha256Hex } from './stable-hash.js';

export function newExternalCapabilityTaskId(): string {
  return `task_${randomUUID()}`;
}

export function newExternalCapabilityLeaseToken(): string {
  return randomUUID();
}

export function newExternalCapabilityCompletionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function externalCapabilityCompletionTokenMatches(
  expectedHash: unknown,
  token: string,
): boolean {
  if (typeof expectedHash !== 'string' || !token) return false;
  const actual = Buffer.from(externalCapabilityCompletionTokenHash(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function externalCapabilityCompletionTokenHash(token: string): string {
  return sha256Hex(`gantry:external-capability-completion:v1:${token}`);
}
