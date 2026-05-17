import { describe, expect, it } from 'vitest';

import {
  evaluateEgressDenylist,
  normalizeEgressHost,
  validateEgressDenylistPattern,
} from '@core/shared/egress-policy.js';

describe('egress policy', () => {
  it('allows every host when denylist is empty', () => {
    expect(
      evaluateEgressDenylist({
        settings: { denylist: [] },
        host: 'api.linkedin.com',
      }),
    ).toBeUndefined();
  });

  it('matches case-insensitive hostname globs', () => {
    expect(
      evaluateEgressDenylist({
        settings: { denylist: ['*.blocked.example.com'] },
        host: 'API.Blocked.Example.Com',
      }),
    ).toMatchObject({
      host: 'api.blocked.example.com',
      matchedPattern: '*.blocked.example.com',
    });
    expect(
      evaluateEgressDenylist({
        settings: { denylist: ['*.blocked.example.com'] },
        host: 'blocked.example.com',
      }),
    ).toBeUndefined();
  });

  it('canonicalizes trailing-dot hostnames before matching', () => {
    expect(normalizeEgressHost('API.LinkedIn.Com.')).toBe('api.linkedin.com');
    expect(validateEgressDenylistPattern('API.LinkedIn.Com.')).toBe(
      'api.linkedin.com',
    );
    expect(
      evaluateEgressDenylist({
        settings: { denylist: ['api.linkedin.com'] },
        host: 'api.linkedin.com.',
      }),
    ).toMatchObject({
      host: 'api.linkedin.com',
      matchedPattern: 'api.linkedin.com',
    });
  });

  it('rejects URL, port, and path patterns', () => {
    expect(() =>
      validateEgressDenylistPattern('https://api.example.com/path'),
    ).toThrow('must be a hostname glob');
    expect(() => validateEgressDenylistPattern('api.example.com:443')).toThrow(
      'must be a hostname glob',
    );
    expect(() => validateEgressDenylistPattern('api.example.com/path')).toThrow(
      'must be a hostname glob',
    );
  });
});
