import { describe, expect, it } from 'vitest';

import { bindingRowToGroup } from '@core/adapters/storage/postgres/repositories/canonical-binding-repository.postgres.js';

describe('canonical binding repository route projection', () => {
  it('reconstructs registered groups from binding columns instead of memory-subject route blobs', () => {
    const row = {
      id: 'conversation-route:tg:100',
      agentId: 'agent:main_agent',
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
      }),
      displayName: 'Main Telegram',
      triggerPattern: '@main',
      requiresTrigger: false,
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)).toEqual({
      jid: 'tg:100',
      group: {
        name: 'Main Telegram',
        folder: 'main_agent',
        trigger: '@main',
        added_at: '2026-05-06T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
    expect(JSON.parse(row.memorySubjectJson)).not.toHaveProperty('group');
    expect(JSON.parse(row.memorySubjectJson)).not.toHaveProperty('jid');
  });

  it('ignores non-route, disabled, and thread-scoped binding rows', () => {
    const baseRow = {
      id: 'conversation-route:tg:100',
      agentId: 'agent:main_agent',
      conversationId: 'conversation:tg:100',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'tg:100' }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:tg:100',
      }),
      displayName: 'Main Telegram',
      triggerPattern: '@main',
      requiresTrigger: false,
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
      conversationId: 'conversation:app:one',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'app:one' }),
      conversationKind: 'group',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:app:one',
      }),
      displayName: 'App Conversation',
      triggerPattern: null,
      requiresTrigger: false,
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
          agentConfig: {
            model: 'opus',
            thinking: { mode: 'enabled', effort: 'high' },
            timeout: 120000,
          },
        },
      }),
      displayName: 'Ops',
      triggerPattern: '@ops',
      requiresTrigger: true,
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
      conversationId: 'conversation:tg:5759865942',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'tg:5759865942' }),
      conversationKind: 'direct',
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:tg:5759865942',
      }),
      displayName: 'Main Agent',
      triggerPattern: '@main',
      requiresTrigger: false,
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
});
