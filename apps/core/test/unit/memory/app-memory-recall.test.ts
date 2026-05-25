import { describe, expect, it } from 'vitest';

import { describeAppMemorySearchOutcome } from '@core/memory/app-memory-recall.js';

describe('app memory recall search metadata', () => {
  it('exposes the resolved subject when a search has no matching memory', () => {
    const outcome = describeAppMemorySearchOutcome(
      {
        appId: 'default',
        agentId: 'agent:team',
        channelId: 'conversation:sl:C123',
        threadId: 'thread-1',
        subjectTypes: ['channel'],
        includeCommon: false,
        query: 'deploy',
      },
      0,
    );

    expect(outcome).toEqual({
      resolvedSubject: {
        appId: 'default',
        agentId: 'agent:team',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        channelId: 'conversation:sl:C123',
      },
      empty_reason: 'no_matching_memory',
    });
  });

  it('marks empty searches with no allowed visible subject filters', () => {
    const outcome = describeAppMemorySearchOutcome(
      {
        appId: 'default',
        agentId: 'agent:team',
        groupId: 'team',
        subjectTypes: ['user'],
        includeCommon: false,
        query: 'style',
      },
      0,
    );

    expect(outcome.resolvedSubject).toMatchObject({
      appId: 'default',
      agentId: 'agent:team',
      subjectType: 'group',
      subjectId: 'team',
    });
    expect(outcome.empty_reason).toBe('no_visible_subject_filters');
  });

  it('does not attach an empty reason when recall finds results', () => {
    expect(
      describeAppMemorySearchOutcome(
        {
          appId: 'default',
          agentId: 'agent:team',
          groupId: 'team',
          query: 'style',
        },
        1,
      ),
    ).not.toHaveProperty('empty_reason');
  });
});
