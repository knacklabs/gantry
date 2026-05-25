import { describe, expect, it } from 'vitest';

import {
  resolveScopedMemorySubject,
  searchInputForResolvedMemorySubject,
} from '@core/memory/app-memory-subject-resolver.js';

describe('app memory subject resolver', () => {
  it('resolves channel memory from trusted conversation context', () => {
    const { subject, scope } = resolveScopedMemorySubject({
      appId: 'default',
      agentId: 'agent:team',
      groupId: 'team',
      conversationId: 'sl:C123',
      userId: 'sl:U123',
      threadId: 'thread-1',
      defaultScope: 'group',
    });

    expect(scope).toBe('group');
    expect(subject).toMatchObject({
      appId: 'default',
      agentId: 'agent:team',
      subjectType: 'channel',
      subjectId: 'conversation:sl:C123',
      channelId: 'conversation:sl:C123',
    });
    expect(subject).not.toHaveProperty('threadId');
  });

  it('builds search inputs that do not widen channel subjects to group rows', () => {
    const { subject } = resolveScopedMemorySubject({
      appId: 'default',
      agentId: 'agent:team',
      groupId: 'team',
      conversationId: 'sl:C123',
      threadId: 'thread-1',
    });

    expect(searchInputForResolvedMemorySubject(subject)).toEqual({
      appId: 'default',
      agentId: 'agent:team',
      channelId: 'conversation:sl:C123',
      subjectTypes: ['channel'],
      includeCommon: false,
    });
  });

  it('does not invent a legacy personal agent id', () => {
    expect(() =>
      resolveScopedMemorySubject({
        appId: 'default',
        agentId: '',
        groupId: 'team',
      }),
    ).toThrow(/requires agentId/);
  });
});
