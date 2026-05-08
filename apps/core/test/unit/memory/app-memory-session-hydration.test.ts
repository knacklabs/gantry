import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeSessionScopeKey } from '@core/domain/repositories/ops-repo.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';
import {
  loadBoundaryExtractionAppMemoryItems,
  loadSessionAppMemoryItems,
} from '@core/memory/app-memory-session-hydration.js';
import { rawThreadIdFromSession } from '@core/memory/app-memory-session-scope.js';

type FakeMemoryItem = {
  id: string;
  appId: string;
  agentId: string;
  subjectType: 'user' | 'channel';
  subjectId: string;
  userId?: string;
  channelId?: string;
  threadId?: string;
  kind: 'decision' | 'preference';
  key: string;
  value: string;
};

function installMemoryServiceRows(rows: FakeMemoryItem[]) {
  const listForHydrationReadOnly = vi.fn(async (input: any) =>
    rows.filter((row) => {
      const subjectType = input.subjectTypes?.[0];
      if (row.appId !== input.appId) return false;
      if (row.agentId !== input.agentId) return false;
      if (subjectType && row.subjectType !== subjectType) return false;
      if (input.userId && row.userId !== input.userId) return false;
      if (input.channelId && row.channelId !== input.channelId) return false;
      if (input.threadId) return row.threadId === input.threadId;
      return !row.threadId;
    }),
  );
  const searchForHydrationReadOnly = vi.fn(async () => []);
  vi.spyOn(AppMemoryService, 'getInstance').mockReturnValue({
    listForHydrationReadOnly,
    searchForHydrationReadOnly,
  } as never);
  return { listForHydrationReadOnly, searchForHydrationReadOnly };
}

describe('app memory session hydration scope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps boundary prior-memory retrieval isolated to the current agent in shared DMs', async () => {
    const service = installMemoryServiceRows([
      {
        id: 'memory-agent-a',
        appId: 'default',
        agentId: 'agent:a',
        subjectType: 'user',
        subjectId: 'user:shared',
        userId: 'user:shared',
        kind: 'preference',
        key: 'preference:a',
        value: 'Agent A memory.',
      },
      {
        id: 'memory-agent-b',
        appId: 'default',
        agentId: 'agent:b',
        subjectType: 'user',
        subjectId: 'user:shared',
        userId: 'user:shared',
        kind: 'preference',
        key: 'preference:b',
        value: 'Agent B memory.',
      },
    ]);

    const items = await loadBoundaryExtractionAppMemoryItems({
      session: {
        id: 'session:a' as never,
        appId: 'default' as never,
        agentId: 'agent:a' as never,
        conversationId: 'conversation:dm-shared' as never,
        userId: 'user:shared' as never,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z' as never,
        updatedAt: '2026-01-01T00:00:00.000Z' as never,
      },
      defaultScope: 'user',
      limit: 10,
    });

    expect(service.listForHydrationReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:a',
        userId: 'user:shared',
        subjectTypes: ['user'],
        includeCommon: false,
        limit: 10,
      }),
    );
    expect(items).toEqual([
      {
        id: 'memory-agent-a',
        key: 'preference:a',
        value: 'Agent A memory.',
      },
    ]);
  });

  it('uses raw app-memory thread ids when retrieving prior memory for canonical session threads', async () => {
    const service = installMemoryServiceRows([
      {
        id: 'memory-topic-7',
        appId: 'default',
        agentId: 'agent:a',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        channelId: 'conversation:sl:C123',
        threadId: 'topic-7',
        kind: 'decision',
        key: 'decision:thread',
        value: 'Raw thread memory is visible.',
      },
    ]);

    const items = await loadBoundaryExtractionAppMemoryItems({
      session: {
        id: 'session:thread' as never,
        appId: 'default' as never,
        agentId: 'agent:a' as never,
        conversationId: 'conversation:sl:C123' as never,
        threadId: 'thread:sl:C123:topic-7' as never,
        userId: 'user:shared' as never,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z' as never,
        updatedAt: '2026-01-01T00:00:00.000Z' as never,
      },
      defaultScope: 'group',
      limit: 10,
    });

    expect(service.listForHydrationReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:a',
        channelId: 'conversation:sl:C123',
        threadId: 'topic-7',
        subjectTypes: ['channel'],
        includeCommon: false,
        limit: 10,
      }),
    );
    expect(items).toEqual([
      {
        id: 'memory-topic-7',
        key: 'decision:thread',
        value: 'Raw thread memory is visible.',
      },
    ]);
  });

  it('decodes encoded session scope thread components before app-memory hydration', async () => {
    const session = {
      id: 'session:teams-thread' as never,
      appId: 'default' as never,
      agentId: 'agent:a' as never,
      conversationId: 'conversation:teams:general' as never,
      threadId: 'thread:teams:general:19:abc@thread.v2' as never,
      userId: makeSessionScopeKey('agent:a', '19:abc@thread.v2', {
        conversationJid: 'teams:general',
        conversationKind: 'channel',
      }) as never,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z' as never,
      updatedAt: '2026-01-01T00:00:00.000Z' as never,
    };
    const service = installMemoryServiceRows([
      {
        id: 'memory-teams-thread',
        appId: 'default',
        agentId: 'agent:a',
        subjectType: 'channel',
        subjectId: 'conversation:teams:general',
        channelId: 'conversation:teams:general',
        threadId: '19:abc@thread.v2',
        kind: 'decision',
        key: 'decision:teams-thread',
        value: 'Teams raw thread memory is visible.',
      },
    ]);

    const items = await loadSessionAppMemoryItems({
      session,
      conversationKind: 'channel',
      limit: 10,
    });

    expect(rawThreadIdFromSession(session)).toBe('19:abc@thread.v2');
    expect(service.listForHydrationReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:a',
        channelId: 'conversation:teams:general',
        threadId: '19:abc@thread.v2',
        subjectTypes: ['channel'],
        includeCommon: false,
        limit: 10,
      }),
    );
    expect(items).toEqual([
      expect.objectContaining({
        id: 'memory-teams-thread',
        subject: expect.objectContaining({
          threadId: '19:abc@thread.v2',
        }),
      }),
    ]);
  });
});
