import { describe, expect, it } from 'vitest';

import {
  computeBrowserIpcAuthToken,
  computeIpcAuthToken,
  computeMemoryIpcAuthToken,
  validateIpcAuthToken,
} from '@core/runtime/ipc-auth.js';

describe('ipc auth token', () => {
  it('validates tokens for the matching group folder', () => {
    const token = computeIpcAuthToken('team-alpha');
    expect(validateIpcAuthToken('team-alpha', token)).toBe(true);
  });

  it('rejects tokens for other group folders', () => {
    const token = computeIpcAuthToken('team-alpha');
    expect(validateIpcAuthToken('team-beta', token)).toBe(false);
  });

  it('binds threaded tokens to the exact group and thread', () => {
    const token = computeIpcAuthToken('team-alpha', 'thread-a');
    expect(validateIpcAuthToken('team-alpha', token, 'thread-a')).toBe(true);
    expect(validateIpcAuthToken('team-alpha', token, 'thread-b')).toBe(false);
    expect(validateIpcAuthToken('team-alpha', token)).toBe(false);
  });

  it('derives browser IPC tokens from group, chat, and thread scope', () => {
    expect(computeBrowserIpcAuthToken('team-alpha', 'tg:1')).not.toBe(
      computeIpcAuthToken('team-alpha'),
    );
    expect(computeBrowserIpcAuthToken('team-alpha', 'tg:1')).not.toBe(
      computeBrowserIpcAuthToken('team-alpha', 'tg:2'),
    );
    expect(
      computeBrowserIpcAuthToken('team-alpha', 'tg:1', 'thread-a'),
    ).not.toBe(computeBrowserIpcAuthToken('team-alpha', 'tg:1', 'thread-b'));
  });

  it('derives memory IPC tokens from group, user, default scope, and thread', () => {
    expect(computeMemoryIpcAuthToken('team-alpha', {})).not.toBe(
      computeIpcAuthToken('team-alpha'),
    );
    expect(
      computeMemoryIpcAuthToken('team-alpha', {
        userId: 'u-1',
        defaultScope: 'user',
      }),
    ).not.toBe(
      computeMemoryIpcAuthToken('team-alpha', {
        userId: 'u-2',
        defaultScope: 'user',
      }),
    );
    expect(
      computeMemoryIpcAuthToken('team-alpha', {
        userId: 'u-1',
        defaultScope: 'user',
      }),
    ).not.toBe(
      computeMemoryIpcAuthToken('team-alpha', {
        userId: 'u-1',
        defaultScope: 'group',
      }),
    );
  });

  it('rejects empty or malformed tokens', () => {
    expect(validateIpcAuthToken('team-alpha', '')).toBe(false);
    expect(validateIpcAuthToken('team-alpha', 'not-a-real-token')).toBe(false);
  });
});
