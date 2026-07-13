import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeSessionScopeKey } from '@core/domain/repositories/ops-repo.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';
import {
  loadBoundaryExtractionAppMemoryItems,
  loadSessionAppMemoryItems,
} from '@core/memory/app-memory-session-hydration.js';
import { parseSessionScopeKey } from '@core/memory/app-memory-session-scope.js';

type FakeMemoryItem = {
  id: string;
  appId: string;
  agentId: string;
  subjectType: 'user' | 'channel';
  subjectId: string;
  userId?: string;
  groupId?: string;
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
      if (input.groupId && row.groupId !== input.groupId) return false;
      if (input.channelId && row.channelId !== input.channelId) return false;
      return true;
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

  it('retrieves whole-channel prior memory for canonical session threads', async () => {
    const service = installMemoryServiceRows([
      {
        id: 'memory-channel',
        appId: 'default',
        agentId: 'agent:a',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        channelId: 'conversation:sl:C123',
        kind: 'decision',
        key: 'decision:channel',
        value: 'Whole-channel memory is visible from any thread.',
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
        subjectTypes: ['channel'],
        includeCommon: false,
        limit: 10,
      }),
    );
    expect(items).toEqual([
      {
        id: 'memory-channel',
        key: 'decision:channel',
        value: 'Whole-channel memory is visible from any thread.',
      },
    ]);
  });

  it('normalizes provider-account canonical conversation ids to live channel memory subjects', async () => {
    const service = installMemoryServiceRows([
      {
        id: 'memory-slack-channel',
        appId: 'default',
        agentId: 'agent:a',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        channelId: 'conversation:sl:C123',
        kind: 'decision',
        key: 'decision:slack-channel',
        value:
          'Slack channel memory remains visible after provider account scoping.',
      },
    ]);

    const items = await loadBoundaryExtractionAppMemoryItems({
      session: {
        id: 'session:slack-provider-account' as never,
        appId: 'default' as never,
        agentId: 'agent:a' as never,
        conversationId: 'conversation:slack_default:sl:C123' as never,
        threadId: 'thread:slack_default:sl:C123:1783507744.385419' as never,
        userId: 'agent:a' as never,
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
        subjectTypes: ['channel'],
        includeCommon: false,
        limit: 10,
      }),
    );
    expect(items).toEqual([
      {
        id: 'memory-slack-channel',
        key: 'decision:slack-channel',
        value:
          'Slack channel memory remains visible after provider account scoping.',
      },
    ]);
  });

  it('normalizes provider-account marker canonical ids without provider-specific prefixes', async () => {
    const service = installMemoryServiceRows([
      {
        id: 'memory-provider-account-channel',
        appId: 'default',
        agentId: 'agent:a',
        subjectType: 'channel',
        subjectId: 'conversation:chat:room',
        channelId: 'conversation:chat:room',
        kind: 'decision',
        key: 'decision:provider-account-channel',
        value: 'Provider-account marker ids share the live channel subject.',
      },
    ]);

    const items = await loadBoundaryExtractionAppMemoryItems({
      session: {
        id: 'session:provider-account-marker' as never,
        appId: 'default' as never,
        agentId: 'agent:a' as never,
        conversationId:
          'conversation:channel-providerAccount:default:chat:chat:room' as never,
        userId: 'agent:a' as never,
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
        channelId: 'conversation:chat:room',
        subjectTypes: ['channel'],
        includeCommon: false,
        limit: 10,
      }),
    );
    expect(items).toEqual([
      {
        id: 'memory-provider-account-channel',
        key: 'decision:provider-account-channel',
        value: 'Provider-account marker ids share the live channel subject.',
      },
    ]);
  });

  it('uses the parent conversation from encoded session scopes for app-memory hydration', async () => {
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
        id: 'memory-teams-channel',
        appId: 'default',
        agentId: 'agent:a',
        subjectType: 'channel',
        subjectId: 'conversation:teams:general',
        groupId: 'agent:a',
        channelId: 'conversation:teams:general',
        kind: 'decision',
        key: 'decision:teams-channel',
        value: 'Teams channel memory is visible across reply chains.',
      },
    ]);

    const items = await loadSessionAppMemoryItems({
      session,
      conversationKind: 'channel',
      limit: 10,
    });

    expect(parseSessionScopeKey({ session })).toMatchObject({
      isScopeKey: true,
      groupId: 'agent:a',
    });
    expect(service.listForHydrationReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:a',
        channelId: 'conversation:teams:general',
        subjectTypes: ['channel'],
        includeCommon: false,
        limit: 10,
      }),
    );
    expect(items).toEqual([
      expect.objectContaining({
        id: 'memory-teams-channel',
        subject: expect.not.objectContaining({ threadId: expect.anything() }),
      }),
    ]);
  });

  it('uses lexical-only bounded query recall for first-visible hydration', async () => {
    const queryHit = {
      id: 'memory-query-hit',
      appId: 'default',
      agentId: 'agent:a',
      subjectType: 'channel',
      subjectId: 'conversation:sl:C123',
      channelId: 'conversation:sl:C123',
      kind: 'decision',
      key: 'decision:query-hit',
      value: 'Query-relevant memory is still available before first output.',
    } satisfies FakeMemoryItem;
    const listForHydrationReadOnly = vi.fn(async () => [queryHit]);
    const searchForHydrationReadOnly = vi.fn(async () => [
      {
        item: queryHit,
        score: 0.8,
        lexicalScore: 0.8,
        vectorScore: 0,
        reasons: ['lexical'],
      },
    ]);
    vi.spyOn(AppMemoryService, 'getInstance').mockReturnValue({
      listForHydrationReadOnly,
      searchForHydrationReadOnly,
    } as never);

    const items = await loadSessionAppMemoryItems({
      session: {
        id: 'session:first-visible' as never,
        appId: 'default' as never,
        agentId: 'agent:a' as never,
        conversationId: 'conversation:sl:C123' as never,
        userId: 'agent:a' as never,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z' as never,
        updatedAt: '2026-01-01T00:00:00.000Z' as never,
      },
      conversationKind: 'channel',
      hydrationMode: 'first_visible',
      limit: 2,
      query: 'release decision',
    });

    expect(searchForHydrationReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'release decision',
        channelId: 'conversation:sl:C123',
      }),
      { statementTimeoutMs: 250, allowEmbeddings: false },
    );
    expect(listForHydrationReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'conversation:sl:C123',
      }),
      { statementTimeoutMs: 250 },
    );
    expect(items.map((item) => item.id)).toEqual(['memory-query-hit']);
  });
});
