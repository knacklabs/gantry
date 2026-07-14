import { describe, expect, it } from 'vitest';

import { resolveRunnerIpcRoute } from '@core/runtime/ipc-route-authorization.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import type { ConversationRoute } from '@core/domain/types.js';

function route(providerAccountId: string): ConversationRoute {
  return {
    name: providerAccountId,
    folder: 'team',
    trigger: '@Gantry',
    added_at: '2026-06-30T00:00:00.000Z',
    agentId: 'agent:team',
    providerAccountId,
  };
}

describe('resolveRunnerIpcRoute', () => {
  it('uses the requested provider account before checking route ambiguity', () => {
    const routes = {
      [makeAgentThreadQueueKey('slack:C123', 'agent:team', null, 'acct:a')]:
        route('acct:a'),
      [makeAgentThreadQueueKey('slack:C123', 'agent:team', null, 'acct:b')]:
        route('acct:b'),
    };

    expect(
      resolveRunnerIpcRoute({
        routes,
        sourceAgentFolder: 'team',
        targetJid: 'slack:C123',
        providerAccountId: 'acct:b',
      }),
    ).toEqual({ targetJid: 'slack:C123', providerAccountId: 'acct:b' });
  });

  it('derives the provider account from the resolved route', () => {
    const routes = {
      [makeAgentThreadQueueKey('slack:C123', 'agent:team', null, 'acct:a')]:
        route('acct:a'),
    };

    expect(
      resolveRunnerIpcRoute({
        routes,
        sourceAgentFolder: 'team',
        targetJid: 'slack:C123',
      }),
    ).toEqual({ targetJid: 'slack:C123', providerAccountId: 'acct:a' });
  });

  it('rejects a provider account mismatch on a resolved route', () => {
    const routes = {
      [makeAgentThreadQueueKey('slack:C123', 'agent:team', null, 'acct:a')]:
        route('acct:a'),
    };

    expect(() =>
      resolveRunnerIpcRoute({
        routes,
        sourceAgentFolder: 'team',
        targetJid: 'slack:C123',
        providerAccountId: 'acct:b',
      }),
    ).toThrow(/ambiguous|unauthorized/);
  });

  it('rejects a thread-scoped route when the request omits the thread', () => {
    const routes = {
      [makeAgentThreadQueueKey('slack:C123', 'agent:team', '1700.1', 'acct:a')]:
        route('acct:a'),
    };

    expect(() =>
      resolveRunnerIpcRoute({
        routes,
        sourceAgentFolder: 'team',
        targetJid: 'slack:C123',
        providerAccountId: 'acct:a',
      }),
    ).toThrow(/ambiguous|unauthorized/);
  });
});
