import { describe, expect, it } from 'vitest';

import {
  hasRouteForConversation,
  resolveConversationMessageRoute,
} from '@core/control/server/external-ingress-adapter.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

describe('external ingress adapter', () => {
  it('uses the conversation provider account when resolving live routes', () => {
    const routes = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack-alpha')]: {
        folder: 'ops',
        providerAccountId: 'slack-alpha',
      },
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack-beta')]: {
        folder: 'ops',
        providerAccountId: 'slack-beta',
      },
    };

    expect(
      resolveConversationMessageRoute(
        routes,
        'sl:C123',
        null,
        'slack-beta',
        'agent:ops',
      ),
    ).toEqual({
      agentId: 'agent:ops',
      queueKey: makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        null,
        'slack-beta',
      ),
    });
  });

  it('requires a matching provider account for routability precheck', () => {
    const routes = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack-alpha')]: {
        folder: 'ops',
        providerAccountId: 'slack-alpha',
      },
    };

    expect(
      hasRouteForConversation(routes, 'sl:C123', null, 'slack-alpha'),
    ).toBe(true);
    expect(hasRouteForConversation(routes, 'sl:C123', null, 'slack-beta')).toBe(
      false,
    );
  });

  it('accepts thread-scoped routes during routability precheck', () => {
    const routes = {
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        '1749.1',
        'slack-alpha',
      )]: {
        folder: 'ops',
        providerAccountId: 'slack-alpha',
      },
    };

    expect(
      hasRouteForConversation(routes, 'sl:C123', '1749.1', 'slack-alpha'),
    ).toBe(true);
    expect(
      hasRouteForConversation(routes, 'sl:C123', null, 'slack-alpha'),
    ).toBe(false);
  });
});
