import { describe, expect, it, vi } from 'vitest';

const testLogger = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: testLogger,
}));

import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import {
  PostgresCanonicalGraphRepository,
  conversationIdForJid,
} from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import {
  PostgresCanonicalBindingRepository,
  bindingRowToGroup,
} from '@core/adapters/storage/postgres/repositories/canonical-binding-repository.postgres.js';
import { CanonicalBindingOpsService } from '@core/adapters/storage/postgres/services/canonical-binding-ops-service.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import type { ConversationRoute } from '@core/domain/types.js';

describe('canonical binding repository route projection', () => {
  it('skips a prefix-only route row and loads every valid route', async () => {
    const validRows = ['tg:100', 'tg:200'].map((chatJid) => ({
      id: `conversation-route:${chatJid}`,
      agentId: 'agent:main_agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: `conversation:provider-account:telegram:${chatJid}`,
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: chatJid }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({ route: { trigger: '@main' } }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    }));
    const malformedRow = {
      ...validRows[0]!,
      id: 'conversation-route:',
      conversationExternalRefJson: JSON.stringify({ jid: 'tg:legacy' }),
    };
    const repository = {
      listConversationRoutes: vi.fn(async () => [malformedRow, ...validRows]),
    } as unknown as PostgresCanonicalBindingRepository;
    testLogger.warn.mockClear();

    const routes = await new CanonicalBindingOpsService(
      repository,
    ).getAllConversationRoutes();

    expect(Object.keys(routes).sort()).toEqual(['tg:100', 'tg:200']);
    expect(routes).not.toHaveProperty('tg:legacy');
    expect(testLogger.warn).toHaveBeenCalledOnce();
    expect(testLogger.warn).toHaveBeenCalledWith(
      {
        event: 'conversation_route_row_skipped',
        rowId: 'conversation-route:',
        reason: 'missing_route_key',
      },
      'Skipped malformed conversation route row during load',
    );
  });

  it('skips a route row without a provider account and loads valid routes', async () => {
    const validRow = {
      id: 'conversation-route:tg:100',
      agentId: 'agent:main_agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: 'conversation:provider-account:telegram:tg:100',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'tg:100' }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({ route: { trigger: '@main' } }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    const repository = {
      listConversationRoutes: vi.fn(async () => [
        {
          ...validRow,
          id: 'conversation-route:tg:malformed',
          providerAccountId: ' ',
        },
        validRow,
      ]),
    } as unknown as PostgresCanonicalBindingRepository;
    testLogger.warn.mockClear();

    const routes = await new CanonicalBindingOpsService(
      repository,
    ).getAllConversationRoutes();

    expect(Object.keys(routes)).toEqual(['tg:100']);
    expect(testLogger.warn).toHaveBeenCalledOnce();
    expect(testLogger.warn).toHaveBeenCalledWith(
      {
        event: 'conversation_route_row_skipped',
        rowId: 'conversation-route:tg:malformed',
        reason: 'missing_provider_account_id',
      },
      'Skipped malformed conversation route row during load',
    );
  });

  it('keeps thread-qualified and conversation-wide routes out of alias dedup', async () => {
    const chatJid = 'tg:100';
    const agentId = 'agent:main_agent';
    const providerAccountId = 'provider-account:telegram';
    const threadRouteKey = makeAgentThreadQueueKey(
      chatJid,
      agentId,
      'thread-1',
      providerAccountId,
    );
    const baseRow = {
      agentId,
      providerAccountId,
      conversationId: `conversation:${providerAccountId}:${chatJid}`,
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: chatJid }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({ route: { trigger: '@main' } }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    const repository = {
      listConversationRoutes: vi.fn(async () => [
        { ...baseRow, id: `conversation-route:${chatJid}` },
        { ...baseRow, id: `conversation-route:${threadRouteKey}` },
      ]),
    } as unknown as PostgresCanonicalBindingRepository;
    testLogger.warn.mockClear();

    const routes = await new CanonicalBindingOpsService(
      repository,
    ).getAllConversationRoutes();

    expect(Object.keys(routes).sort()).toEqual(
      [chatJid, threadRouteKey].sort(),
    );
    expect(testLogger.warn).not.toHaveBeenCalled();
  });

  it('keeps only the fully-qualified route across mixed aliases without collapsing distinct identities', async () => {
    const providerAccountId = 'provider-account:telegram';
    const agentQualifiedRouteKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:main_agent',
    );
    const fullyQualifiedRouteKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:main_agent',
      undefined,
      providerAccountId,
    );
    const otherAgentRouteKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:other_agent',
      undefined,
      providerAccountId,
    );
    const otherAccountRouteKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:main_agent',
      undefined,
      'provider-account:telegram-two',
    );
    const baseRow = {
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'tg:100' }),
      conversationKind: 'group',
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    const rows = [
      {
        ...baseRow,
        id: 'conversation-route:tg:100',
        agentId: 'agent:main_agent',
        providerAccountId,
        conversationId: 'sales_telegram',
        memorySubjectJson: JSON.stringify({
          route: { conversationId: 'sales_telegram', trigger: '@main' },
        }),
      },
      {
        ...baseRow,
        id: `conversation-route:${agentQualifiedRouteKey}`,
        agentId: 'agent:main_agent',
        providerAccountId,
        conversationId: `conversation:${providerAccountId}:tg:100`,
        memorySubjectJson: JSON.stringify({ route: { trigger: '@main' } }),
      },
      {
        ...baseRow,
        id: `conversation-route:${fullyQualifiedRouteKey}`,
        agentId: 'agent:main_agent',
        providerAccountId,
        conversationId: `conversation:${providerAccountId}:tg:100`,
        memorySubjectJson: JSON.stringify({ route: { trigger: '@main' } }),
      },
      {
        ...baseRow,
        id: `conversation-route:${otherAgentRouteKey}`,
        agentId: 'agent:other_agent',
        providerAccountId,
        conversationId: `conversation:${providerAccountId}:tg:100`,
        memorySubjectJson: JSON.stringify({ route: { trigger: '@other' } }),
      },
      {
        ...baseRow,
        id: `conversation-route:${otherAccountRouteKey}`,
        agentId: 'agent:main_agent',
        providerAccountId: 'provider-account:telegram-two',
        conversationId: 'conversation:provider-account:telegram-two:tg:100',
        memorySubjectJson: JSON.stringify({ route: { trigger: '@main' } }),
      },
    ];
    const repository = {
      listConversationRoutes: vi.fn(async () => rows),
    } as unknown as PostgresCanonicalBindingRepository;
    testLogger.warn.mockClear();

    const routes = await new CanonicalBindingOpsService(
      repository,
    ).getAllConversationRoutes();

    expect(Object.keys(routes).sort()).toEqual(
      [fullyQualifiedRouteKey, otherAgentRouteKey, otherAccountRouteKey].sort(),
    );
    expect(routes[fullyQualifiedRouteKey]?.conversationId).toBe(
      `conversation:${providerAccountId}:tg:100`,
    );
    expect(testLogger.warn).toHaveBeenCalledTimes(2);
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'conversation_route_alias_dropped',
        droppedRouteId: 'conversation-route:tg:100',
        keptRouteIds: [`conversation-route:${fullyQualifiedRouteKey}`],
        chatJid: 'tg:100',
        agentId: 'agent:main_agent',
        providerAccountId,
      }),
      'Dropped stale conversation route alias during load',
    );
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'conversation_route_alias_dropped',
        droppedRouteId: `conversation-route:${agentQualifiedRouteKey}`,
        keptRouteIds: [`conversation-route:${fullyQualifiedRouteKey}`],
        chatJid: 'tg:100',
        agentId: 'agent:main_agent',
        providerAccountId,
      }),
      'Dropped stale conversation route alias during load',
    );
  });

  it('drops a bare alias when the agent-qualified route omits its provider account', async () => {
    const chatJid = 'tg:100';
    const agentId = 'agent:main_agent';
    const providerAccountId = 'provider-account:telegram';
    const qualifiedRouteKey = makeAgentThreadQueueKey(chatJid, agentId);
    const baseRow = {
      agentId,
      providerAccountId,
      conversationId: `conversation:${providerAccountId}:${chatJid}`,
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: chatJid }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({ route: { trigger: '@main' } }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    const repository = {
      listConversationRoutes: vi.fn(async () => [
        { ...baseRow, id: `conversation-route:${chatJid}` },
        { ...baseRow, id: `conversation-route:${qualifiedRouteKey}` },
      ]),
    } as unknown as PostgresCanonicalBindingRepository;
    testLogger.warn.mockClear();

    const routes = await new CanonicalBindingOpsService(
      repository,
    ).getAllConversationRoutes();

    expect(Object.keys(routes)).toEqual([qualifiedRouteKey]);
    expect(routes[qualifiedRouteKey]?.conversationId).toBe(
      `conversation:${providerAccountId}:${chatJid}`,
    );
    expect(testLogger.warn).toHaveBeenCalledOnce();
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'conversation_route_alias_dropped',
        droppedRouteId: `conversation-route:${chatJid}`,
        keptRouteIds: [`conversation-route:${qualifiedRouteKey}`],
      }),
      'Dropped stale conversation route alias during load',
    );
  });

  it('groups provider-account aliases that differ only by surrounding whitespace', async () => {
    const chatJid = 'tg:100';
    const agentId = 'agent:main_agent';
    const providerAccountId = 'provider-account:telegram';
    const qualifiedRouteKey = makeAgentThreadQueueKey(
      chatJid,
      agentId,
      undefined,
      providerAccountId,
    );
    const baseRow = {
      agentId,
      conversationId: `conversation:${providerAccountId}:${chatJid}`,
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: chatJid }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({ route: { trigger: '@main' } }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    const repository = {
      listConversationRoutes: vi.fn(async () => [
        {
          ...baseRow,
          id: `conversation-route:${chatJid}`,
          providerAccountId,
        },
        {
          ...baseRow,
          id: `conversation-route:${qualifiedRouteKey}`,
          providerAccountId: `  ${providerAccountId}  `,
        },
      ]),
    } as unknown as PostgresCanonicalBindingRepository;
    testLogger.warn.mockClear();

    const routes = await new CanonicalBindingOpsService(
      repository,
    ).getAllConversationRoutes();

    expect(Object.keys(routes)).toEqual([qualifiedRouteKey]);
    expect(routes[qualifiedRouteKey]?.providerAccountId).toBe(
      providerAccountId,
    );
    expect(testLogger.warn).toHaveBeenCalledOnce();
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'conversation_route_alias_dropped',
        droppedRouteId: `conversation-route:${chatJid}`,
        keptRouteIds: [`conversation-route:${qualifiedRouteKey}`],
        providerAccountId,
      }),
      'Dropped stale conversation route alias during load',
    );
  });

  it('skips a row with conflicting route-key qualifiers', async () => {
    const chatJid = 'tg:200';
    const agentId = 'agent:main_agent';
    const providerAccountId = 'provider-account:telegram';
    const conflictingRouteKey = makeAgentThreadQueueKey(
      chatJid,
      agentId,
      undefined,
      'provider-account:other',
    );
    const baseRow = {
      agentId,
      providerAccountId,
      conversationId: `conversation:${providerAccountId}:${chatJid}`,
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: chatJid }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({ route: { trigger: '@main' } }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    const repository = {
      listConversationRoutes: vi.fn(async () => [
        { ...baseRow, id: `conversation-route:${chatJid}` },
        { ...baseRow, id: `conversation-route:${conflictingRouteKey}` },
      ]),
    } as unknown as PostgresCanonicalBindingRepository;
    testLogger.warn.mockClear();

    const routes = await new CanonicalBindingOpsService(
      repository,
    ).getAllConversationRoutes();

    expect(Object.keys(routes)).toEqual([chatJid]);
    expect(routes).not.toHaveProperty(conflictingRouteKey);
    expect(testLogger.warn).toHaveBeenCalledOnce();
    expect(testLogger.warn).toHaveBeenCalledWith(
      {
        event: 'conversation_route_row_conflicting_qualifiers',
        rowId: `conversation-route:${conflictingRouteKey}`,
        parsedAgentId: agentId,
        rowAgentId: agentId,
        parsedProviderAccountId: 'provider-account:other',
        rowProviderAccountId: providerAccountId,
      },
      'Skipped conflicting conversation route row during load',
    );
  });

  it('reconstructs agent-qualified binding ids as persisted route keys', () => {
    const routeKey = makeAgentThreadQueueKey('tg:100', 'agent:main_agent');
    const row = {
      id: `conversation-route:${routeKey}`,
      agentId: 'agent:main_agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: 'conversation:provider-account:telegram:tg:100',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({
        kind: 'conversation',
        value: '100',
        jid: 'tg:100',
      }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:provider-account:telegram:tg:100',
        route: {
          trigger: '@main',
          requiresTrigger: false,
        },
      }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)).toMatchObject({ jid: routeKey });
  });

  it('reconstructs registered groups from conversation install route metadata', () => {
    const row = {
      id: 'conversation-route:tg:100',
      agentId: 'agent:main_agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: 'conversation:provider-account:telegram:tg:100',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({
        kind: 'conversation',
        value: '100',
        jid: 'tg:100',
      }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:provider-account:telegram:tg:100',
        route: {
          trigger: '@main',
          requiresTrigger: false,
        },
      }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)).toEqual({
      jid: 'tg:100',
      group: {
        name: 'Main Telegram',
        folder: 'main_agent',
        conversationId: 'conversation:provider-account:telegram:tg:100',
        providerAccountId: 'provider-account:telegram',
        trigger: '@main',
        added_at: '2026-05-06T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
    expect(JSON.parse(row.memorySubjectJson)).not.toHaveProperty('group');
    expect(JSON.parse(row.memorySubjectJson)).not.toHaveProperty('jid');
  });

  it('uses the persisted route key instead of a provider-account conversation id', () => {
    const row = {
      id: 'conversation-route:sl:C123',
      agentId: 'agent:main_agent',
      providerAccountId: 'slack_default',
      conversationId: 'conversation:slack_default:sl:C123',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({
        kind: 'conversation',
        value: 'C123',
      }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:slack_default:sl:C123',
        route: {
          trigger: '@Gantry',
          requiresTrigger: true,
        },
      }),
      displayName: 'Slack General',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)).toMatchObject({ jid: 'sl:C123' });
  });

  it('loads a legacy conversation id unchanged and warns once', async () => {
    const providerAccountId = 'provider-account:slack';
    const routeKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:main_agent',
      undefined,
      providerAccountId,
    );
    const row = {
      id: `conversation-route:${routeKey}`,
      agentId: 'agent:main_agent',
      providerAccountId,
      conversationId: 'sales_slack',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'sl:C123' }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        route: { conversationId: 'sales_slack', trigger: '@main' },
      }),
      displayName: 'Sales Slack',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    const repository = {
      listConversationRoutes: vi.fn(async () => [row]),
    } as unknown as PostgresCanonicalBindingRepository;
    testLogger.warn.mockClear();

    const routes = await new CanonicalBindingOpsService(
      repository,
    ).getAllConversationRoutes();

    expect(routes[routeKey]?.conversationId).toBe('sales_slack');
    expect(testLogger.warn).toHaveBeenCalledOnce();
    expect(testLogger.warn).toHaveBeenCalledWith(
      {
        event: 'conversation_route_conversation_id_noncanonical',
        rowId: `conversation-route:${routeKey}`,
        storedConversationId: 'sales_slack',
        expectedCanonicalConversationId: `conversation:${providerAccountId}:sl:C123`,
      },
      'Loaded non-canonical conversation route conversation id',
    );
  });

  it('ignores non-route, disabled, and thread-scoped binding rows', () => {
    const baseRow = {
      id: 'conversation-route:tg:100',
      agentId: 'agent:main_agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: 'conversation:tg:100',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'tg:100' }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:tg:100',
        route: {
          trigger: '@main',
          requiresTrigger: false,
        },
      }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(
      bindingRowToGroup({ ...baseRow, id: 'agent-binding:one' }),
    ).toBeUndefined();
    expect(
      bindingRowToGroup({ ...baseRow, status: 'disabled' }),
    ).toBeUndefined();
    expect(
      bindingRowToGroup({ ...baseRow, threadId: 'thread-1' }),
    ).toBeUndefined();
  });

  it('uses a non-empty trigger fallback for always-on bindings without trigger patterns', () => {
    const row = {
      id: 'conversation-route:app:one',
      agentId: 'agent:main_agent',
      providerAccountId: 'provider-account:app',
      conversationId: 'conversation:provider-account:app:app:one',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'app:one' }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:provider-account:app:app:one',
        route: {
          requiresTrigger: false,
        },
      }),
      displayName: 'App Conversation',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)?.group).toMatchObject({
      folder: 'main_agent',
      trigger: '@main_agent',
      requiresTrigger: false,
    });
  });

  it('restores persisted route agentConfig overrides', () => {
    const row = {
      id: 'conversation-route:sl:C123',
      agentId: 'agent:main_agent',
      providerAccountId: 'provider-account:slack',
      conversationId: 'conversation:provider-account:slack:sl:C123',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'sl:C123' }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:provider-account:slack:sl:C123',
        route: {
          trigger: '@ops',
          requiresTrigger: true,
          agentConfig: {
            model: 'opus',
            thinking: { mode: 'enabled', effort: 'high' },
            timeout: 120000,
          },
        },
      }),
      displayName: 'Ops',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)?.group.agentConfig).toEqual({
      model: 'opus',
      thinking: { mode: 'enabled', effort: 'high' },
      timeout: 120000,
    });
  });

  it('preserves direct and channel route kind for memory scope after restart', () => {
    const directRow = {
      id: 'conversation-route:tg:5759865942',
      agentId: 'agent:main_agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: 'conversation:provider-account:telegram:tg:5759865942',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'tg:5759865942' }),
      conversationKind: 'direct',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:provider-account:telegram:tg:5759865942',
        route: {
          trigger: '@main',
          requiresTrigger: false,
        },
      }),
      displayName: 'Main Agent',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    const channelRow = {
      ...directRow,
      id: 'conversation-route:tg:-1003986348737',
      conversationId:
        'conversation:provider-account:telegram:tg:-1003986348737',
      conversationExternalRefJson: JSON.stringify({
        jid: 'tg:-1003986348737',
      }),
      conversationKind: 'group',
      displayName: 'Main Agent Telegram Group',
    };

    expect(bindingRowToGroup(directRow)?.group.conversationKind).toBe('dm');
    expect(bindingRowToGroup(channelRow)?.group.conversationKind).toBe(
      'channel',
    );
  });

  it('normalizes and round-trips a correctly qualified route key', async () => {
    const providerAccountId = 'provider-account:default:tg';
    const routeKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:main_agent',
      undefined,
      providerAccountId,
    );
    const insertedRows: unknown[] = [];
    const tx = {
      insert: vi.fn(() => ({
        values: (value: unknown) => {
          insertedRows.push(value);
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        },
      })),
    } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const ensureConversation = vi.fn(
      async (jid: string) => `conversation:provider-account:default:tg:${jid}`,
    );
    const ensureAgent = vi.fn(async () => 'agent:main_agent');
    const getConversationInstallationId = vi.fn(async () => providerAccountId);

    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation,
      ensureAgent,
      getConversationInstallationId,
    };

    await repo.saveConversationRoute(routeKey, {
      name: 'Main',
      folder: 'main_agent',
      conversationId: 'configured:shared',
      trigger: '@main',
      added_at: '2026-06-01T00:00:00.000Z',
      requiresTrigger: true,
      conversationKind: 'channel',
      providerAccountId,
    } as ConversationRoute);

    expect(ensureConversation).toHaveBeenCalledOnce();
    expect(ensureConversation).toHaveBeenCalledWith(
      'tg:100',
      expect.objectContaining({
        isGroup: true,
        providerAccountId,
      }),
      tx,
    );
    expect(ensureConversation).not.toHaveBeenCalledWith(
      'tg:100::agent:agent%3Amain_agent',
      expect.anything(),
      tx,
    );
    expect(ensureAgent).toHaveBeenCalledWith('main_agent', 'Main', tx);
    expect(insertedRows).toHaveLength(1);
    expect(
      insertedRows[0] as { id: string; conversationId: string },
    ).toMatchObject({
      id: `conversation-route:${routeKey}`,
      conversationId: 'conversation:provider-account:default:tg:tg:100',
    });
    expect(
      JSON.parse(
        (insertedRows[0] as { memorySubjectJson: string }).memorySubjectJson,
      ).route.conversationId,
    ).toBe('conversation:provider-account:default:tg:tg:100');

    vi.spyOn(repo, 'listConversationRoutes').mockResolvedValue([
      {
        ...(insertedRows[0] as Record<string, unknown>),
        threadId: null,
        conversationExternalRefJson: JSON.stringify({ jid: 'tg:100' }),
        conversationKind: 'group',
      } as any,
    ]);
    const routes = await new CanonicalBindingOpsService(
      repo,
    ).getAllConversationRoutes();

    expect(routes[routeKey]).toMatchObject({
      folder: 'main_agent',
      conversationId: 'conversation:provider-account:default:tg:tg:100',
      providerAccountId,
    });
  });

  it('infers an omitted provider account from the stored legacy conversation before validation', async () => {
    const providerAccountId = 'provider-account:custom:slack';
    const routeKey = makeAgentThreadQueueKey('sl:C123', 'agent:main_agent');
    const insertedRows: unknown[] = [];
    const tx = {
      insert: vi.fn(() => ({
        values: (value: unknown) => {
          insertedRows.push(value);
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        },
      })),
    } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const ensureConversation = vi.fn(async () => 'sales_slack');
    const getConversationInstallationId = vi.fn(async () => providerAccountId);
    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation,
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId,
    };

    await repo.saveConversationRoute(routeKey, {
      name: 'Sales Slack',
      folder: 'main_agent',
      conversationId: 'sales_slack',
      trigger: '@main',
      added_at: '2026-06-01T00:00:00.000Z',
      requiresTrigger: true,
      conversationKind: 'channel',
    } as ConversationRoute);

    expect(ensureConversation).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        existingConversationId: 'sales_slack',
        providerAccountId,
      }),
      tx,
    );
    expect(getConversationInstallationId).toHaveBeenNthCalledWith(
      1,
      'sales_slack',
      tx,
    );
    expect(
      getConversationInstallationId.mock.invocationCallOrder[0],
    ).toBeLessThan(ensureConversation.mock.invocationCallOrder[0]!);
    expect(insertedRows[0]).toMatchObject({
      conversationId: 'sales_slack',
      providerAccountId,
    });
  });

  it('uses the route-key provider qualifier when the route omits its provider account', async () => {
    const providerAccountId = 'provider-account:default:tg';
    const routeKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:main_agent',
      undefined,
      providerAccountId,
    );
    const insertedRows: unknown[] = [];
    const tx = {
      insert: vi.fn(() => ({
        values: (value: unknown) => {
          insertedRows.push(value);
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        },
      })),
    } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const ensureConversation = vi.fn(
      async () => `conversation:${providerAccountId}:tg:100`,
    );
    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation,
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId: vi.fn(async () => providerAccountId),
    };

    await repo.saveConversationRoute(routeKey, {
      name: 'Main',
      folder: 'main_agent',
      conversationId: `conversation:${providerAccountId}:tg:100`,
      trigger: '@main',
      added_at: '2026-06-01T00:00:00.000Z',
      requiresTrigger: true,
      conversationKind: 'channel',
    } as ConversationRoute);

    expect(ensureConversation).toHaveBeenCalledWith(
      'tg:100',
      expect.objectContaining({ providerAccountId }),
      tx,
    );
    expect(insertedRows[0]).toMatchObject({ providerAccountId });
  });

  it('rejects a route only after conversation installation inference finds no provider account', async () => {
    const routeKey = makeAgentThreadQueueKey('tg:100', 'agent:main_agent');
    const insert = vi.fn();
    const tx = { insert } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const ensureConversation = vi.fn(async () => 'conversation:tg:100');
    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation,
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId: vi.fn(async () => undefined),
    };

    await expect(
      repo.saveConversationRoute(routeKey, {
        name: 'Main',
        folder: 'main_agent',
        conversationId: 'conversation:tg:100',
        trigger: '@main',
        added_at: '2026-06-01T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
      } as ConversationRoute),
    ).rejects.toThrow(
      `Cannot persist conversation route ${routeKey} without providerAccountId`,
    );
    expect(ensureConversation).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects a route-key provider qualifier that conflicts with the installed account', async () => {
    const routeKeyProviderAccountId = 'provider-account:telegram';
    const installedProviderAccountId = 'provider-account:other';
    const routeKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:main_agent',
      undefined,
      routeKeyProviderAccountId,
    );
    const insert = vi.fn();
    const tx = { insert } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation: vi.fn(
        async () => `conversation:${routeKeyProviderAccountId}:tg:100`,
      ),
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId: vi.fn(
        async () => installedProviderAccountId,
      ),
    };

    await expect(
      repo.saveConversationRoute(routeKey, {
        name: 'Main',
        folder: 'main_agent',
        conversationId: `conversation:${routeKeyProviderAccountId}:tg:100`,
        trigger: '@main',
        added_at: '2026-06-01T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
      } as ConversationRoute),
    ).rejects.toThrow(
      `Conversation route ${routeKey} resolved provider account ${installedProviderAccountId}, expected ${routeKeyProviderAccountId}`,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects a provider qualifier that conflicts with the route provider account', async () => {
    const providerAccountId = 'provider-account:telegram';
    const routeKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:main_agent',
      undefined,
      'provider-account:other',
    );
    const insert = vi.fn();
    const tx = { insert } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation: vi.fn(
        async () => `conversation:${providerAccountId}:tg:100`,
      ),
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId: vi.fn(async () => providerAccountId),
    };

    await expect(
      repo.saveConversationRoute(routeKey, {
        name: 'Main',
        folder: 'main_agent',
        conversationId: `conversation:${providerAccountId}:tg:100`,
        trigger: '@main',
        added_at: '2026-06-01T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
        providerAccountId,
      } as ConversationRoute),
    ).rejects.toThrow(
      `Conversation route ${routeKey} provider account qualifier provider-account:other does not match requested provider account ${providerAccountId}`,
    );
    expect(insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects an agent qualifier that conflicts with the route folder', async () => {
    const providerAccountId = 'provider-account:telegram';
    const routeKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:other_agent',
      undefined,
      providerAccountId,
    );
    const insert = vi.fn();
    const tx = { insert } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation: vi.fn(
        async () => `conversation:${providerAccountId}:tg:100`,
      ),
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId: vi.fn(async () => providerAccountId),
    };

    await expect(
      repo.saveConversationRoute(routeKey, {
        name: 'Main',
        folder: 'main_agent',
        conversationId: `conversation:${providerAccountId}:tg:100`,
        trigger: '@main',
        added_at: '2026-06-01T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
        providerAccountId,
      } as ConversationRoute),
    ).rejects.toThrow(
      `Conversation route ${routeKey} agent qualifier agent:other_agent does not match resolved agent agent:main_agent`,
    );
    expect(insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('updates a route whose conversation resolves to a legacy id', async () => {
    const providerAccountId = 'provider-account:slack';
    const routeKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:main_agent',
      undefined,
      providerAccountId,
    );
    const insertedRows: unknown[] = [];
    const tx = {
      insert: vi.fn(() => ({
        values: (value: unknown) => {
          insertedRows.push(value);
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        },
      })),
    } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const repo = new PostgresCanonicalBindingRepository(db);
    const ensureConversation = vi.fn(async () => 'sales_slack');
    (repo as any).graph = {
      ensureConversation,
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId: vi.fn(async () => providerAccountId),
    };

    await expect(
      new CanonicalBindingOpsService(repo).setConversationRoute(routeKey, {
        name: 'Sales Slack',
        folder: 'main_agent',
        conversationId: 'sales_slack',
        trigger: '@main',
        added_at: '2026-06-01T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
        providerAccountId,
      } as ConversationRoute),
    ).resolves.toBeUndefined();
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      conversationId: 'sales_slack',
    });
    expect(ensureConversation).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({ existingConversationId: 'sales_slack' }),
      tx,
    );
  });

  it('validates an existing conversation id hint before reusing it', async () => {
    const providerAccountId = 'provider-account:slack';
    const existingRow = {
      appId: 'default',
      providerAccountId,
      externalRefJson: JSON.stringify({ jid: 'sl:C123' }),
    };
    const makeGraph = (conversationRows: Array<Record<string, unknown>>) => {
      let query: any;
      query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(async () => conversationRows),
      };
      const insertedRows: Array<Record<string, unknown>> = [];
      const db = {
        select: vi.fn(() => query),
        insert: vi.fn(() => ({
          values: (value: Record<string, unknown>) => {
            insertedRows.push(value);
            return {
              onConflictDoNothing: vi.fn(async () => undefined),
              onConflictDoUpdate: vi.fn(async () => undefined),
            };
          },
        })),
      } as any;
      return {
        graph: new PostgresCanonicalGraphRepository(db),
        insertedRows,
      };
    };

    const matching = makeGraph([existingRow]);
    await expect(
      matching.graph.ensureConversation('sl:C123', {
        providerAccountId,
        existingConversationId: 'sales_slack',
      }),
    ).resolves.toBe('sales_slack');
    expect(matching.insertedRows.at(-1)).toMatchObject({ id: 'sales_slack' });

    const missing = makeGraph([]);
    await expect(
      missing.graph.ensureConversation('sl:C123', {
        providerAccountId,
        existingConversationId: 'sales_settings_key',
      }),
    ).resolves.toBe(conversationIdForJid('sl:C123', providerAccountId));
    expect(missing.insertedRows.at(-1)).toMatchObject({
      id: conversationIdForJid('sl:C123', providerAccountId),
    });

    const mismatched = makeGraph([
      {
        ...existingRow,
        externalRefJson: JSON.stringify({ jid: 'sl:C999' }),
      },
    ]);
    await expect(
      mismatched.graph.ensureConversation('sl:C123', {
        providerAccountId,
        existingConversationId: 'sales_settings_key',
      }),
    ).rejects.toThrow(
      'Existing conversation sales_settings_key does not match route sl:C123',
    );
    expect(mismatched.insertedRows).toEqual([]);
  });

  it('loads and updates a legacy route with unprefixed agent identities', async () => {
    const providerAccountId = 'provider-account:slack';
    const routeKey = makeAgentThreadQueueKey(
      'sl:C123',
      'main_agent',
      undefined,
      providerAccountId,
    );
    const row = {
      id: `conversation-route:${routeKey}`,
      agentId: 'main_agent',
      providerAccountId,
      conversationId: `conversation:${providerAccountId}:sl:C123`,
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'sl:C123' }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({ route: { trigger: '@main' } }),
      displayName: 'Sales Slack',
      createdAt: '2026-06-01T00:00:00.000Z',
    };
    const insertedRows: unknown[] = [];
    const tx = {
      insert: vi.fn(() => ({
        values: (value: unknown) => {
          insertedRows.push(value);
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        },
      })),
    } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const repo = new PostgresCanonicalBindingRepository(db);
    vi.spyOn(repo, 'listConversationRoutes').mockResolvedValue([row]);
    (repo as any).graph = {
      ensureConversation: vi.fn(async () => row.conversationId),
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId: vi.fn(async () => providerAccountId),
    };
    const service = new CanonicalBindingOpsService(repo);

    const loaded = await service.getConversationRoute(routeKey);
    expect(loaded).toMatchObject({
      folder: 'main_agent',
      providerAccountId,
    });
    await expect(
      service.setConversationRoute(routeKey, loaded!),
    ).resolves.toBeUndefined();
    expect(insertedRows).toHaveLength(1);
  });

  it('requires active provider accounts when loading active route rows', async () => {
    let query: any;
    query = {
      from: vi.fn(() => query),
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(async () => []),
    };
    const db = {
      select: vi.fn(() => query),
    } as any;

    const repo = new PostgresCanonicalBindingRepository(db);
    await repo.listConversationRoutes();

    expect(query.innerJoin).toHaveBeenCalledWith(
      pgSchema.providerAccountsPostgres,
      expect.anything(),
    );
  });
});
