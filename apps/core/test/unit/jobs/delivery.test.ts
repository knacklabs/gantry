import { describe, expect, it, vi } from 'vitest';

import { PartialMessageDeliveryError } from '@core/domain/messages/partial-delivery.js';
import { AmbiguousDurableDeliveryError } from '@core/domain/messages/durable-delivery.js';
import {
  formatDeliveryIncomplete,
  sendJobNotification,
  settleDeliveryAttempt,
} from '@core/jobs/delivery.js';
import type { Job } from '@core/domain/types.js';
import { logger } from '@core/infrastructure/logging/logger.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    app_id: 'default',
    name: 'test',
    prompt: 'run',
    schedule_type: 'manual',
    schedule: '',
    enabled: true,
    status: 'active',
    created_by: 'user',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    max_retries: 3,
    retry_backoff_ms: 1_000,
    consecutive_failures: 0,
    max_consecutive_failures: 3,
    timeout_ms: 120_000,
    ...overrides,
  } as Job;
}

describe('jobs/delivery', () => {
  it('classifies partial delivery exceptions as delivery_incomplete', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const partial = new PartialMessageDeliveryError({
      cause: new Error('second chunk failed'),
      deliveredChunks: 1,
      totalChunks: 2,
      name: 'PartialDelivery',
      message: 'partial',
    });
    Object.assign(partial, { provider: 'telegram' });

    const settlement = await settleDeliveryAttempt(
      async () => {
        throw partial;
      },
      { scope: 'test', target: 'tg:1' },
    );

    expect(settlement).toBe('delivery_incomplete');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'telegram',
        operatorMessage: [
          'Message delivery incomplete.',
          'cause: telegram rejected part 2/2',
          'recover: see logs for the full output and retry after fixing delivery.',
        ].join('\n'),
      }),
      'Delivery attempt ended in partial visibility; marking as delivery_incomplete',
    );
    warn.mockRestore();
  });

  it('formats partial delivery operator copy', () => {
    expect(
      formatDeliveryIncomplete({
        provider: 'telegram',
        rejectedPart: 2,
        totalParts: 3,
      }),
    ).toBe(
      [
        'Message delivery incomplete.',
        'cause: telegram rejected part 2/3',
        'recover: see logs for the full output and retry after fixing delivery.',
      ].join('\n'),
    );
  });

  it('classifies ambiguous durable send settlement as delivery_incomplete', async () => {
    const ambiguous = new AmbiguousDurableDeliveryError({
      provider: 'slack',
      conversationJid: 'sl:C123',
      cause: new Error('sent-state persistence failed'),
    });

    const settlement = await settleDeliveryAttempt(
      async () => {
        throw ambiguous;
      },
      { scope: 'test', target: 'sl:C123' },
    );

    expect(settlement).toBe('delivery_incomplete');
  });

  it('dispatches durable notifications for unique routes with canonical profiles', async () => {
    const job = makeJob({
      notification_routes: [
        {
          conversationJid: 'tg:1',
          threadId: null,
          label: 'dm',
        },
        {
          conversationJid: 'tg:1',
          threadId: null,
          label: 'duplicate',
        },
        {
          conversationJid: 'sl:C123',
          threadId: 'thread-1',
          label: 'channel',
        },
      ],
    });
    const enqueue = vi
      .fn<
        (input: {
          profileId: string;
          idempotencyKey: string;
          route: { conversationJid: string; threadId: string | null };
        }) => Promise<void>
      >()
      .mockResolvedValue(undefined);

    const delivered = await sendJobNotification({
      job,
      text: 'hello',
      phase: 'start',
      runId: 'run-1',
      enqueueDurableNotification: enqueue as any,
    });

    expect(delivered).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        profileId: 'job.notification.start.v1',
        route: expect.objectContaining({
          conversationJid: 'tg:1',
          threadId: null,
        }),
      }),
    );
    expect(enqueue).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        profileId: 'job.notification.start.v1',
        route: expect.objectContaining({
          conversationJid: 'sl:C123',
          threadId: 'thread-1',
        }),
      }),
    );
    expect(enqueue.mock.calls[0]?.[0].idempotencyKey).toMatch(
      /^job\.notification:start:[0-9a-f]{40}$/,
    );
  });

  it('uses stable route idempotency keys and summary profile id', async () => {
    const job = makeJob({
      notification_routes: [
        {
          conversationJid: 'tg:1',
          threadId: null,
          label: 'dm',
        },
      ],
    });
    const enqueue = vi
      .fn<
        (input: { profileId: string; idempotencyKey: string }) => Promise<void>
      >()
      .mockResolvedValue(undefined);

    await sendJobNotification({
      job,
      text: 'summary text',
      phase: 'summary',
      runId: 'run-1',
      enqueueDurableNotification: enqueue as any,
    });
    await sendJobNotification({
      job,
      text: 'summary text',
      phase: 'summary',
      runId: 'run-1',
      enqueueDurableNotification: enqueue as any,
    });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]?.[0].profileId).toBe(
      'job.notification.summary.v1',
    );
    expect(enqueue.mock.calls[1]?.[0].profileId).toBe(
      'job.notification.summary.v1',
    );
    expect(enqueue.mock.calls[0]?.[0].idempotencyKey).toBe(
      enqueue.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it('falls back to direct sends when durable enqueue is unavailable', async () => {
    const job = makeJob({
      notification_routes: [
        {
          conversationJid: 'tg:1',
          threadId: null,
          label: 'dm',
        },
        {
          conversationJid: 'sl:C123',
          threadId: 'thread-1',
          label: 'thread',
        },
      ],
    });
    const partial = new PartialMessageDeliveryError({
      cause: new Error('partial'),
      deliveredChunks: 1,
      totalChunks: 2,
      name: 'PartialDelivery',
      message: 'partial',
    });
    Object.assign(partial, { provider: 'telegram' });
    const send = vi
      .fn<(...args: [string, string, { threadId: string }?]) => Promise<void>>()
      .mockRejectedValueOnce(partial);

    const delivered = await sendJobNotification({
      job,
      text: 'hello',
      phase: 'summary',
      runId: 'run-1',
      sendMessage: send as any,
    });

    expect(delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 'tg:1', 'hello');
    expect(send).toHaveBeenNthCalledWith(2, 'sl:C123', 'hello', {
      threadId: 'thread-1',
    });
  });

  it('sends notifications to saved notification routes instead of execution context', async () => {
    const job = makeJob({
      execution_context: {
        conversationJid: 'tg:team',
        threadId: 'trigger-topic',
        workspaceKey: 'team',
      },
      notification_routes: [
        {
          conversationJid: 'tg:team',
          threadId: 'job-topic',
          label: 'primary',
        },
      ],
    });
    const send = vi
      .fn<(...args: [string, string, { threadId: string }?]) => Promise<void>>()
      .mockResolvedValue(undefined);

    const delivered = await sendJobNotification({
      job,
      text: 'done',
      phase: 'summary',
      runId: 'run-1',
      sendMessage: send as any,
    });

    expect(delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('tg:team', 'done', {
      threadId: 'job-topic',
    });
  });

  it('does not block scheduler progress when direct notification delivery hangs', async () => {
    vi.useFakeTimers();
    try {
      const job = makeJob({
        notification_routes: [
          {
            conversationJid: 'tg:1',
            threadId: null,
            label: 'dm',
          },
        ],
      });
      const send = vi.fn(() => new Promise<void>(() => undefined));
      const delivered = sendJobNotification({
        job,
        text: 'done',
        phase: 'summary',
        runId: 'run-1',
        sendMessage: send as any,
      });

      await vi.advanceTimersByTimeAsync(5_000);

      await expect(delivered).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses user-facing notifications for silent jobs', async () => {
    const job = makeJob({
      silent: true,
      notification_routes: [
        {
          conversationJid: 'tg:1',
          threadId: null,
          label: 'dm',
        },
      ],
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const delivered = await sendJobNotification({
      job,
      text: 'hello',
      phase: 'start',
      sendMessage: send,
      enqueueDurableNotification: enqueue,
    });

    expect(delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
