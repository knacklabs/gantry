import { describe, expect, it, vi } from 'vitest';

import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import {
  PostgresCanonicalBindingRepository,
  bindingRowToGroup,
} from '@core/adapters/storage/postgres/repositories/canonical-binding-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import type { ConversationRoute } from '@core/domain/types.js';

describe('canonical binding repository route projection', () => {
  it('reconstructs agent-qualified binding ids as persisted route keys', () => {
    const routeKey = makeAgentThreadQueueKey('tg:100', 'agent:main_agent');
    const row = {
      id: `conversation-route:${routeKey}`,
      agentId: 'agent:main_agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: 'conversation:tg:100',
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
        conversationId: 'conversation:tg:100',
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
      conversationId: 'conversation:tg:100',
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
        conversationId: 'conversation:tg:100',
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
      conversationId: 'conversation:app:one',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'app:one' }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:app:one',
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
      conversationId: 'conversation:sl:C123',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'sl:C123' }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:sl:C123',
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
      conversationId: 'conversation:tg:5759865942',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'tg:5759865942' }),
      conversationKind: 'direct',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:tg:5759865942',
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
      conversationId: 'conversation:tg:-1003986348737',
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

  it('normalizes route keys to bare JIDs before ensuring conversations', async () => {
    const routeKey = makeAgentThreadQueueKey('tg:100', 'agent:main_agent');
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
      async (jid: string) => `conversation:${jid}`,
    );
    const ensureAgent = vi.fn(async () => 'agent:main_agent');
    const getConversationInstallationId = vi.fn(
      async () => 'provider-account:default:tg',
    );

    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation,
      ensureAgent,
      getConversationInstallationId,
    };

    await repo.saveConversationRoute(routeKey, {
      name: 'Main',
      folder: 'main_agent',
      trigger: '@main',
      added_at: '2026-06-01T00:00:00.000Z',
      requiresTrigger: true,
      conversationKind: 'channel',
      providerAccountId: 'provider-account:default:tg',
    } as ConversationRoute);

    expect(ensureConversation).toHaveBeenCalledOnce();
    expect(ensureConversation).toHaveBeenCalledWith(
      'tg:100',
      expect.objectContaining({
        isGroup: true,
        providerAccountId: 'provider-account:default:tg',
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
      conversationId: 'conversation:tg:100',
    });
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
