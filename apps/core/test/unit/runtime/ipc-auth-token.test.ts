import { describe, expect, it } from 'vitest';

import {
  computeBrowserIpcAuthToken,
  computeIpcAuthToken,
  computeMemoryIpcAuthToken,
  isBrowserIpcAuthorized,
  registerBrowserIpcAuthorization,
  revokeBrowserIpcAuthorization,
  validateIpcAuthToken,
} from '@core/runtime/ipc-auth.js';

describe('ipc auth token', () => {
  it('validates tokens for the matching workspace key', () => {
    const token = computeIpcAuthToken('team-alpha');
    expect(validateIpcAuthToken('team-alpha', token)).toBe(true);
  });

  it('rejects tokens for other workspace keys', () => {
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

  it('ref-counts overlapping browser IPC authorizations for the same scope', () => {
    const scope = {
      workspaceKey: 'team-alpha',
      chatJid: 'tg:1',
      threadId: 'thread-a',
    };

    expect(isBrowserIpcAuthorized(scope)).toBe(false);
    registerBrowserIpcAuthorization(scope);
    registerBrowserIpcAuthorization(scope);
    expect(isBrowserIpcAuthorized(scope)).toBe(true);
    revokeBrowserIpcAuthorization(scope);
    expect(isBrowserIpcAuthorized(scope)).toBe(true);
    revokeBrowserIpcAuthorization(scope);
    expect(isBrowserIpcAuthorized(scope)).toBe(false);
  });

  it('derives memory IPC tokens from group, chat, user, default scope, thread, and allowed actions', () => {
    expect(computeMemoryIpcAuthToken('team-alpha', {})).not.toBe(
      computeIpcAuthToken('team-alpha'),
    );
    expect(
      computeMemoryIpcAuthToken('team-alpha', {
        chatJid: 'tg:1',
      }),
    ).not.toBe(
      computeMemoryIpcAuthToken('team-alpha', {
        chatJid: 'tg:2',
      }),
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
    expect(
      computeMemoryIpcAuthToken('team-alpha', {
        allowedActions: ['memory_search', 'memory_save'],
      }),
    ).not.toBe(
      computeMemoryIpcAuthToken('team-alpha', {
        allowedActions: ['memory_search', 'memory_patch'],
      }),
    );
  });

  it('rejects empty or malformed tokens', () => {
    expect(validateIpcAuthToken('team-alpha', '')).toBe(false);
    expect(validateIpcAuthToken('team-alpha', 'not-a-real-token')).toBe(false);
  });
});
