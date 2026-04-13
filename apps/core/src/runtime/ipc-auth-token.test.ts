import { describe, expect, it } from 'vitest';

import { computeIpcAuthToken, validateIpcAuthToken } from './ipc-auth.js';

describe('ipc auth token', () => {
  it('validates tokens for the matching group folder', () => {
    const token = computeIpcAuthToken('team-alpha');
    expect(validateIpcAuthToken('team-alpha', token)).toBe(true);
  });

  it('rejects tokens for other group folders', () => {
    const token = computeIpcAuthToken('team-alpha');
    expect(validateIpcAuthToken('team-beta', token)).toBe(false);
  });

  it('rejects empty or malformed tokens', () => {
    expect(validateIpcAuthToken('team-alpha', '')).toBe(false);
    expect(validateIpcAuthToken('team-alpha', 'not-a-real-token')).toBe(false);
  });
});
