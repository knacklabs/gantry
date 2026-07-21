import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { forwardRuntimeEvents } from '@core/runtime/runtime-event-forwarding.js';

describe('forwardRuntimeEvents', () => {
  it('treats runtime event persistence as best effort', async () => {
    const publishRuntimeEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime event storage unavailable'))
      .mockResolvedValueOnce(undefined);
    const forwardedKeys = new Set<string>();

    await expect(
      forwardRuntimeEvents({
        output: {
          status: 'success',
          result: 'ok',
          runtimeEvents: [
            {
              eventType: RUNTIME_EVENT_TYPES.MODEL_USAGE,
              payload: { usageEventId: 'first' },
            },
            {
              eventType: RUNTIME_EVENT_TYPES.MODEL_USAGE,
              payload: { usageEventId: 'second' },
            },
          ],
        },
        publishRuntimeEvent,
        runtimeAppId: 'default',
        turnAgentId: 'agent:main',
        runId: 'agent-run:test',
        chatJid: 'sl:C123',
        sessionThreadId: 'thread:sl:C123:1',
        forwardedKeys,
      }),
    ).resolves.toBeUndefined();

    expect(publishRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(forwardedKeys.size).toBe(2);
  });
});
