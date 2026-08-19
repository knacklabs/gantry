import { expect, it } from 'vitest';

import {
  ACCESS_REFERENCE_TTL_MS,
  canDisableOrDemote,
  createOpaqueToken,
  expiresAt,
  hashAuthToken,
  isExpired,
  isRecentlyReauthenticated,
  matchesAuthToken,
} from '@core/application/auth/auth-foundations.js';

it('auth foundations > auth persistence policy stores only hashes and enforces expiry', () => {
  const token = createOpaqueToken();
  const hash = hashAuthToken(token);
  const now = new Date('2026-08-18T00:00:00.000Z');

  expect(hash).not.toContain(token);
  expect(matchesAuthToken(token, hash)).toBe(true);
  expect(matchesAuthToken(`${token}x`, hash)).toBe(false);
  expect(isExpired(expiresAt(now, ACCESS_REFERENCE_TTL_MS), now)).toBe(false);
  expect(isExpired(now, now)).toBe(true);
  expect(isRecentlyReauthenticated(now, new Date(now.getTime() + 1))).toBe(
    true,
  );
  expect(canDisableOrDemote('administrator', 'active', 1)).toBe(false);
  expect(canDisableOrDemote('administrator', 'active', 2)).toBe(true);
});
