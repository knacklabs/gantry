import { describe, expect, it, vi } from 'vitest';

import { createMemoryForgetHandler } from '@core/app/bootstrap/permission-memory-forget-handler.js';
import {
  permissionMemoryAgentRouteKey,
  type UsedByJobReader,
} from '@core/application/permissions/permission-memory-listing.js';
import type { HumanDecisionMemoryService } from '@core/application/permissions/human-decision-memory-service.js';
import type { ConversationRoute } from '@core/domain/types.js';
import {
  HUMAN_DECISION_MEMORY_KIND,
  type PermissionDecisionMemoryRow,
} from '@core/domain/ports/permission-decision-memory.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

const action = {
  kind: 'memory_forget' as const,
  conversationJid: 'app:app-one:dm-one',
  providerAccountId: 'telegram-main',
  threadId: 'thread-one',
  recordId: '00000001-1234-4abc-8def-1234567890ab',
  agentRouteKey: permissionMemoryAgentRouteKey('agent-one'),
};

function row(
  overrides: Partial<PermissionDecisionMemoryRow> = {},
): PermissionDecisionMemoryRow & { shortId: string } {
  return {
    id: action.recordId,
    shortId: '000000',
    appId: 'app-one',
    agentFolder: 'agent-one',
    kind: HUMAN_DECISION_MEMORY_KIND,
    lookupIdentity: 'kind:read_only_command',
    decision: 'allow',
    outcome: 'allow',
    scope: 'kind',
    scopeKey: 'kind:read_only_command',
    actingPersonId: 'person-one',
    reason: 'remembered',
    principal: 'Bash',
    effectSchemaVersion: 1,
    railVersion: 1,
    provenance: 'human_decision:{}',
    createdAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function route(overrides: Partial<ConversationRoute> = {}): ConversationRoute {
  return {
    name: 'DM',
    folder: 'agent-one',
    trigger: '@Agent',
    added_at: '2026-09-02T00:00:00.000Z',
    agentId: 'agent-one',
    providerAccountId: 'telegram-main',
    conversationKind: 'dm',
    ...overrides,
  };
}

function routeEntry(
  value: ConversationRoute,
  conversationJid = action.conversationJid,
) {
  return [
    makeAgentThreadQueueKey(
      conversationJid,
      value.agentId,
      action.threadId,
      value.providerAccountId,
    ),
    value,
  ] as const;
}

function setup(
  input: {
    firstRows?: Array<PermissionDecisionMemoryRow & { shortId: string }>;
    activeRows?: Array<PermissionDecisionMemoryRow & { shortId: string }>;
    revokeResult?: 'applied' | 'already_revoked' | 'not_found';
    routes?: Record<string, ConversationRoute>;
    resolvePerson?: () => Promise<string | undefined>;
    usedBy?: UsedByJobReader;
  } = {},
) {
  const firstRows = input.firstRows ?? [row()];
  const activeRows = input.activeRows ?? [];
  const callOrder: string[] = [];
  const list = vi.fn(async (request: { includeRevoked?: boolean }) => {
    callOrder.push(request.includeRevoked ? 'list:all' : 'list:active');
    return request.includeRevoked ? firstRows : activeRows;
  });
  const revoke = vi.fn(async () => {
    callOrder.push('revoke');
    return input.revokeResult ?? 'applied';
  });
  const service = { list, revoke } as unknown as HumanDecisionMemoryService;
  const routes = input.routes ?? Object.fromEntries([routeEntry(route())]);
  const handler = createMemoryForgetHandler({
    getConversationRoutes: () => routes,
    resolvePerson: input.resolvePerson ?? (async () => 'person-one'),
    resolvePermissionMode: () =>
      'Current permission mode: auto (agent/default).',
    service,
    timezone: 'Asia/Kolkata',
    usedBy: () => input.usedBy ?? (async () => new Map()),
  });
  return { callOrder, handler, list, revoke };
}

describe('permission memory forget handler', () => {
  it('resolves the agent route key then loads the person-scoped current-rails row including revoked before revoking and maps applied with a re-listed view carrying the mode line already-revoked cross-person other-agent stale-rails unknown-route and group-route outcomes to the three replies with zero revoke calls on not-found and already-revoked', async () => {
    const applied = setup({
      activeRows: [
        row({ id: '00000002-1234-4abc-8def-1234567890ab', shortId: '000001' }),
      ],
    });
    await expect(applied.handler(action)).resolves.toMatchObject({
      state: 'applied',
      receipt: "Forgot: read-only reads. I'll ask next time.",
      permissionMemoryListView: {
        text: expect.stringContaining(
          'Current permission mode: auto (agent/default).',
        ),
        affordances: [
          {
            recordId: '00000002-1234-4abc-8def-1234567890ab',
            label: 'Forget 000001',
          },
        ],
      },
    });
    expect(applied.callOrder).toEqual(['list:all', 'revoke', 'list:active']);
    expect(applied.list.mock.calls).toEqual([
      [
        {
          appId: 'app-one',
          agentFolder: 'agent-one',
          actingPersonId: 'person-one',
          includeRevoked: true,
        },
      ],
      [
        {
          appId: 'app-one',
          agentFolder: 'agent-one',
          actingPersonId: 'person-one',
        },
      ],
    ]);

    const activeRows = Array.from({ length: 11 }, (_, index) =>
      row({
        id: `000000${index + 2}-1234-4abc-8def-1234567890ab`,
        shortId: `0000${index + 2}`,
      }),
    );
    const usedBy = vi.fn(async () => new Map());
    const rerendered = setup({ activeRows, usedBy });
    await rerendered.handler(action);
    expect(usedBy).toHaveBeenCalledWith(
      activeRows.slice(0, 10).map(({ id }) => id),
    );

    const revoked = setup({
      firstRows: [row({ revokedAt: '2026-09-02T01:00:00.000Z' })],
    });
    await expect(revoked.handler(action)).resolves.toEqual({
      state: 'stale',
      receipt: 'Already forgotten.',
    });
    expect(revoked.revoke).not.toHaveBeenCalled();

    const raced = setup({ revokeResult: 'already_revoked' });
    await expect(raced.handler(action)).resolves.toEqual({
      state: 'stale',
      receipt: 'Already forgotten.',
    });
    expect(raced.callOrder).toEqual(['list:all', 'revoke']);

    const crossPerson = setup({
      firstRows: [],
      resolvePerson: async () => 'person-one',
    });
    await expect(crossPerson.handler(action)).resolves.toMatchObject({
      state: 'invalid',
    });
    expect(crossPerson.revoke).not.toHaveBeenCalled();

    const staleRails = setup({ firstRows: [] });
    await expect(staleRails.handler(action)).resolves.toMatchObject({
      state: 'invalid',
    });
    expect(staleRails.revoke).not.toHaveBeenCalled();

    const otherRoute = route({ agentId: 'agent-other' });
    const otherAgent = setup({
      routes: Object.fromEntries([
        routeEntry(route()),
        routeEntry(otherRoute, 'app:app-two:dm-two'),
      ]),
    });
    await expect(
      otherAgent.handler({
        ...action,
        agentRouteKey: permissionMemoryAgentRouteKey('agent-other'),
      }),
    ).resolves.toMatchObject({ state: 'invalid' });
    expect(otherAgent.revoke).not.toHaveBeenCalled();

    const unknown = setup();
    await expect(
      unknown.handler({ ...action, agentRouteKey: 'unknown-route' }),
    ).resolves.toMatchObject({ state: 'invalid' });
    expect(unknown.list).not.toHaveBeenCalled();
    expect(unknown.revoke).not.toHaveBeenCalled();

    const group = setup({
      routes: Object.fromEntries([
        routeEntry(route({ conversationKind: 'channel' })),
      ]),
    });
    await expect(group.handler(action)).resolves.toMatchObject({
      state: 'invalid',
    });
    expect(group.list).not.toHaveBeenCalled();
    expect(group.revoke).not.toHaveBeenCalled();
  });
});
