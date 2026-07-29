import { afterEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { logger } from '@core/infrastructure/logging/logger.js';
import { forwardRuntimeEvents } from '@core/runtime/runtime-event-forwarding.js';

describe('forwardRuntimeEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not fail the turn, logs, and keeps a failed event retriable', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const publishRuntimeEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime event storage unavailable'))
      .mockResolvedValueOnce(undefined);
    const forwardedKeys = new Set<string>();

    // (a) still completes without throwing
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
    // (b) the persistence failure is logged as a warning
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // (c) only the successful event's key is recorded; the failed one is NOT
    //     present so a later forwarding pass can retry it.
    expect(forwardedKeys.size).toBe(1);
  });

  it('records the forwarded key when publish succeeds', async () => {
    const publishRuntimeEvent = vi.fn().mockResolvedValue(undefined);
    const forwardedKeys = new Set<string>();

    await forwardRuntimeEvents({
      output: {
        status: 'success',
        result: 'ok',
        runtimeEvents: [
          {
            eventType: RUNTIME_EVENT_TYPES.MODEL_USAGE,
            payload: { usageEventId: 'only' },
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
    });

    expect(publishRuntimeEvent).toHaveBeenCalledTimes(1);
    expect(forwardedKeys.size).toBe(1);
  });
});
