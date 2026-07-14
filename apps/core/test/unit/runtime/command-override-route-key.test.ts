import { describe, expect, it, vi } from 'vitest';

import {
  resolveCommandOverrideRouteKey,
  resolveGroupProcessingRouteContext,
} from '@core/runtime/command-override-route-key.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

describe('command override route keys', () => {
  it('keeps provider account scope while resolving queued routes', () => {
    const routeKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:triage',
      '171.222',
      'slack_one',
    );
    const getGroup = vi.fn(() => ({
      name: 'Triage',
      folder: 'triage',
      trigger: '@triage',
      added_at: '2026-06-30T00:00:00.000Z',
      providerAccountId: 'slack_one',
    }));

    const result = resolveGroupProcessingRouteContext(
      {
        getGroup,
        getRegisteredJids: () => new Set([routeKey]),
      } as any,
      routeKey,
    );

    expect(getGroup).toHaveBeenCalledWith(
      'sl:C123',
      '171.222',
      'agent:triage',
      'slack_one',
    );
    expect(result?.routeKey).toBe(routeKey);
    expect(result?.commandOverrideRouteKey).toBe(routeKey);
  });

  it('keeps provider account scope while falling back to folder route keys', () => {
    const registered = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:triage',
      null,
      'slack_one',
    );

    expect(
      resolveCommandOverrideRouteKey({
        chatJid: 'sl:C123',
        threadId: '171.222',
        providerAccountId: 'slack_one',
        queueAgentId: 'agent:queued',
        agentFolder: 'triage',
        registeredJids: new Set([registered]),
        routeKey: makeAgentThreadQueueKey(
          'sl:C123',
          'agent:queued',
          '171.222',
          'slack_one',
        ),
      }),
    ).toBe(registered);
  });
});
