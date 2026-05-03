import { describe, expect, it, vi } from 'vitest';

import { collectDurableMemoryFromRepositories } from '@core/memory/boundary-extraction-core.js';

describe('collectDurableMemoryFromRepositories', () => {
  function makeRepositories() {
    const saved: unknown[] = [];
    return {
      saved,
      repositories: {
        agentSessions: {
          getAgentSession: vi.fn().mockResolvedValue({
            id: 'agent-session:1',
            appId: 'default',
            agentId: 'agent:kai',
            conversationId: 'conversation:tg-1',
            threadId: undefined,
            userId: 'user:1',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
        messages: {
          listRecentMessages: vi.fn().mockResolvedValue([
            {
              id: 'message:1',
              appId: 'default',
              conversationId: 'conversation:tg-1',
              direction: 'inbound',
              parts: [{ kind: 'text', text: 'Remember this.' }],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ]),
        },
        memory: {
          listMemoryItems: vi.fn().mockResolvedValue([]),
          saveMemoryItem: vi.fn().mockImplementation(async (item) => {
            saved.push(item);
          }),
        },
      },
    };
  }

  it('saves automatic DM boundary memories as user memory', async () => {
    const { repositories, saved } = makeRepositories();

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      defaultScope: 'user',
      extractFacts: () => [
        {
          scope: 'group',
          kind: 'preference',
          key: 'preference:reply-style',
          value: 'Ravi prefers concise replies.',
          confidence: 0.9,
        },
      ],
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      subject: { kind: 'user', userId: 'user:1' },
    });
  });

  it('saves automatic channel boundary memories as conversation memory', async () => {
    const { repositories, saved } = makeRepositories();

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      defaultScope: 'group',
      extractFacts: () => [
        {
          scope: 'user',
          kind: 'decision',
          key: 'decision:release-process',
          value: 'The channel release process requires owner review.',
          confidence: 0.9,
        },
      ],
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      subject: { kind: 'conversation', conversationId: 'conversation:tg-1' },
    });
  });
});
