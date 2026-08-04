import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutboundDeliveryService } from '@core/application/outbound-delivery/outbound-delivery-service.js';
import { AmbiguousDurableDeliveryError } from '@core/domain/messages/durable-delivery.js';
import { PartialMessageDeliveryError } from '@core/domain/messages/partial-delivery.js';
import type { ClaimedOutboundDeliveryItem } from '@core/domain/outbound-delivery/outbound-delivery.js';
import {
  runBoundedOutboundDeliveryRecovery,
  startOutboundDeliveryRecoveryLoop,
  stopOutboundDeliveryRecoveryLoop,
} from '@core/jobs/outbound-delivery-recovery.js';
import { getOperationalErrorCount } from '@core/shared/operational-error-counters.js';

function makeClaimedItem(overrides: Partial<ClaimedOutboundDeliveryItem> = {}) {
  const itemId =
    (overrides.item?.id as string | undefined) ?? 'delivery-item:1';
  const deliveryId =
    (overrides.delivery?.id as string | undefined) ?? 'delivery:1';
  return {
    delivery: {
      id: deliveryId,
      appId: 'app:test',
      conversationId: 'conversation:test',
      profileId: 'profile:test',
      idempotencyKey: `idem:${deliveryId}`,
      status: 'claimed',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
      ...(overrides.delivery ?? {}),
    },
    item: {
      id: itemId,
      deliveryId,
      ordinal: 0,
      canonicalText: 'hello',
      status: 'claimed',
      attemptCount: 1,
      claimToken: `claim:${itemId}`,
      nextAttemptAt: '2026-05-08T00:00:00.000Z',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
      ...(overrides.item ?? {}),
    },
    finalAnswer: null,
  } as ClaimedOutboundDeliveryItem;
}

function makeService(input: {
  claims: ClaimedOutboundDeliveryItem[][];
  settleSentApplied?: boolean[];
}) {
  const claimDueDeliveryItems = vi
    .fn()
    .mockImplementation(async () => input.claims.shift() ?? []);
  const markDeliveryItemSent = vi.fn().mockImplementation(async () => ({
    applied:
      input.settleSentApplied && input.settleSentApplied.length > 0
        ? input.settleSentApplied.shift()
        : true,
    delivery: null,
  }));
  const markDeliveryItemFailed = vi.fn().mockResolvedValue({
    applied: true,
    delivery: null,
  });
  const markDeliveryItemPartiallyDelivered = vi.fn().mockResolvedValue({
    applied: true,
    delivery: null,
  });
  const service = {
    claimPending: claimDueDeliveryItems,
    settleSent: markDeliveryItemSent,
    settleFailed: markDeliveryItemFailed,
    settlePartiallyDelivered: markDeliveryItemPartiallyDelivered,
  } as unknown as OutboundDeliveryService;

  return {
    service,
    claimDueDeliveryItems,
    markDeliveryItemSent,
    markDeliveryItemFailed,
    markDeliveryItemPartiallyDelivered,
  };
}

describe('runBoundedOutboundDeliveryRecovery', () => {
  beforeEach(async () => {
    await stopOutboundDeliveryRecoveryLoop();
  });

  it('reclaims pending and expired rows in bounded batches', async () => {
    const first = makeClaimedItem({
      item: {
        id: 'delivery-item:pending' as never,
        status: 'pending',
      } as never,
    });
    const second = makeClaimedItem({
      item: {
        id: 'delivery-item:expired' as never,
        status: 'claimed',
        claimExpiresAt: '2026-05-07T00:00:00.000Z',
      } as never,
      delivery: {
        id: 'delivery:2' as never,
      } as never,
    });
    const { service, claimDueDeliveryItems, markDeliveryItemSent } =
      makeService({
        claims: [[first, second], []],
      });

    const result = await runBoundedOutboundDeliveryRecovery({
      service,
      appId: 'app:test' as never,
      claimerId: 'runtime-recovery:test',
      batchLimit: 2,
      maxBatches: 3,
      leaseMs: 20_000,
      now: () => '2026-05-08T00:00:00.000Z',
      dispatch: vi.fn(async (claimed) => ({
        status: 'sent',
        providerMessageId: `provider:${claimed.item.id}`,
      })),
      receiptIdempotencyKeyForItem: (claimed) => `receipt:${claimed.item.id}`,
    });

    expect(result).toEqual({
      batches: 2,
      claimed: 2,
      sent: 2,
      failed: 0,
      stoppedReason: 'drained',
    });
    expect(claimDueDeliveryItems).toHaveBeenNthCalledWith(1, {
      appId: 'app:test',
      claimerId: 'runtime-recovery:test',
      limit: 2,
      leaseMs: 20_000,
      now: '2026-05-08T00:00:00.000Z',
    });
    expect(markDeliveryItemSent).toHaveBeenCalledTimes(2);
    expect(markDeliveryItemSent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        itemId: 'delivery-item:pending',
        receiptIdempotencyKey: 'receipt:delivery-item:pending',
      }),
    );
    expect(markDeliveryItemSent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        itemId: 'delivery-item:expired',
        receiptIdempotencyKey: 'receipt:delivery-item:expired',
      }),
    );
  });

  it('claims due rows across app scopes when no appId is provided', async () => {
    const claimed = makeClaimedItem({
      delivery: {
        appId: 'app-one',
        id: 'delivery:app-one:1' as never,
      } as never,
      item: {
        id: 'delivery-item:app-one:1' as never,
      } as never,
    });
    const claimPending = vi.fn(async () => {
      throw new Error('app-scoped claim should not run');
    });
    const claimPendingAcrossApps = vi
      .fn()
      .mockResolvedValueOnce([claimed])
      .mockResolvedValueOnce([]);
    const settleSent = vi.fn(async () => ({ applied: true, delivery: null }));
    const service = {
      claimPending,
      claimPendingAcrossApps,
      settleSent,
      settleFailed: vi.fn(async () => ({ applied: true, delivery: null })),
      settlePartiallyDelivered: vi.fn(async () => ({
        applied: true,
        delivery: null,
      })),
    } as unknown as OutboundDeliveryService;

    const result = await runBoundedOutboundDeliveryRecovery({
      service,
      claimerId: 'runtime-recovery:test',
      batchLimit: 2,
      maxBatches: 3,
      leaseMs: 20_000,
      now: () => '2026-05-08T00:00:00.000Z',
      dispatch: vi.fn(async () => ({
        status: 'sent',
        providerMessageId: 'provider:app-one:1',
      })),
      receiptIdempotencyKeyForItem: (next) => `receipt:${next.item.id}`,
    });

    expect(claimPending).not.toHaveBeenCalled();
    expect(claimPendingAcrossApps).toHaveBeenNthCalledWith(1, {
      claimerId: 'runtime-recovery:test',
      limit: 2,
      leaseMs: 20_000,
      now: '2026-05-08T00:00:00.000Z',
    });
    expect(settleSent).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'delivery:app-one:1',
        itemId: 'delivery-item:app-one:1',
      }),
    );
    expect(result).toEqual({
      batches: 2,
      claimed: 1,
      sent: 1,
      failed: 0,
      stoppedReason: 'drained',
    });
  });

  it('settles branded partial delivery as partially delivered instead of blind full retry', async () => {
    const claimed = makeClaimedItem();
    const {
      service,
      markDeliveryItemFailed,
      markDeliveryItemPartiallyDelivered,
    } = makeService({
      claims: [[claimed], []],
    });

    const result = await runBoundedOutboundDeliveryRecovery({
      service,
      appId: 'app:test' as never,
      claimerId: 'runtime-recovery:test',
      maxBatches: 2,
      now: () => '2026-05-08T00:00:00.000Z',
      dispatch: vi.fn(async () => {
        const partial = new PartialMessageDeliveryError({
          cause: new Error('mid-stream failure'),
          deliveredChunks: 1,
          totalChunks: 2,
          name: 'TelegramChunkDeliveryError',
          message: 'first chunk was visible',
        });
        Object.assign(partial, {
          deliveredParts: 1,
          totalParts: 4,
          retryTail: {
            canonicalText: 'retry me',
            providerPayload: { provider: 'telegram' },
          },
        });
        throw partial;
      }),
    });

    expect(result.failed).toBe(1);
    expect(markDeliveryItemPartiallyDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: claimed.delivery.id,
        itemId: claimed.item.id,
        claimToken: claimed.item.claimToken,
        deliveredParts: 1,
        totalParts: 4,
        retryTail: {
          canonicalText: 'retry me',
          providerPayload: { provider: 'telegram' },
        },
      }),
    );
    expect(markDeliveryItemFailed).not.toHaveBeenCalled();
  });

  it('persists only retry-tail suffix metadata for partial channel delivery recovery', async () => {
    const claimed = makeClaimedItem();
    const {
      service,
      markDeliveryItemPartiallyDelivered,
      markDeliveryItemFailed,
    } = makeService({
      claims: [[claimed], []],
    });

    const fullText = 'visible prefix + unsent tail';
    const unsentTail = 'unsent tail';
    const result = await runBoundedOutboundDeliveryRecovery({
      service,
      appId: 'app:test' as never,
      claimerId: 'runtime-recovery:test',
      maxBatches: 2,
      now: () => '2026-05-08T00:00:00.000Z',
      dispatch: vi.fn(async () => {
        const partial = new PartialMessageDeliveryError({
          cause: new Error('partial send failed'),
          deliveredChunks: 1,
          totalChunks: 2,
          name: 'PartialSlackDeliveryError',
          message: 'first chunk visible',
        });
        Object.assign(partial, {
          deliveredParts: 1,
          totalParts: 2,
          retryTail: {
            canonicalText: unsentTail,
            providerPayload: { provider: 'slack', fullText },
          },
        });
        throw partial;
      }),
    });

    expect(result.failed).toBe(1);
    const partialCall = vi.mocked(markDeliveryItemPartiallyDelivered).mock
      .calls[0]?.[0];
    expect(partialCall).toMatchObject({
      deliveryId: claimed.delivery.id,
      itemId: claimed.item.id,
      claimToken: claimed.item.claimToken,
      retryTail: {
        canonicalText: unsentTail,
        providerPayload: { provider: 'slack' },
      },
    });
    expect(partialCall?.retryTail?.canonicalText).not.toBe(fullText);
    expect(partialCall?.retryTail?.providerPayload).not.toHaveProperty(
      'fullText',
    );
    expect(markDeliveryItemFailed).not.toHaveBeenCalled();
  });

  it('reuses deterministic receipt idempotency keys to avoid duplicate sent provider ids on reclaim', async () => {
    const claimed = makeClaimedItem({
      item: {
        id: 'delivery-item:dup' as never,
      } as never,
    });
    const { service, markDeliveryItemSent } = makeService({
      claims: [[claimed], [claimed], []],
      settleSentApplied: [true, false],
    });

    const result = await runBoundedOutboundDeliveryRecovery({
      service,
      appId: 'app:test' as never,
      claimerId: 'runtime-recovery:test',
      batchLimit: 1,
      maxBatches: 4,
      now: () => '2026-05-08T00:00:00.000Z',
      dispatch: vi.fn(async () => ({
        status: 'sent',
        providerMessageId: 'provider-message-1',
      })),
      receiptIdempotencyKeyForItem: (next) => `receipt:${next.item.id}`,
    });

    expect(markDeliveryItemSent).toHaveBeenCalledTimes(2);
    expect(markDeliveryItemSent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        itemId: 'delivery-item:dup',
        providerMessageId: 'provider-message-1',
        receiptIdempotencyKey: 'receipt:delivery-item:dup',
      }),
    );
    expect(markDeliveryItemSent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        itemId: 'delivery-item:dup',
        providerMessageId: 'provider-message-1',
        receiptIdempotencyKey: 'receipt:delivery-item:dup',
      }),
    );
    expect(result.sent).toBe(1);
  });

  it('marks sent-settlement rejections as ambiguous and prevents lease-expiry redispatch', async () => {
    const claimed = makeClaimedItem({
      item: {
        id: 'delivery-item:ambiguous' as never,
        claimExpiresAt: '2026-05-08T00:00:20.000Z',
      } as never,
    });
    let terminal = false;
    const claimPending = vi.fn(
      async ({
        now,
      }: {
        now: string;
      }): Promise<ClaimedOutboundDeliveryItem[]> => {
        if (terminal) return [];
        if (now >= '2026-05-08T00:00:20.000Z') return [claimed];
        return [claimed];
      },
    );
    const settleSent = vi.fn(async () => {
      throw new Error('receipt write failed');
    });
    const settlePartiallyDelivered = vi.fn(async () => {
      terminal = true;
      return { applied: true, delivery: null };
    });
    const settleFailed = vi.fn(async () => ({ applied: true, delivery: null }));
    const service = {
      claimPending,
      settleSent,
      settlePartiallyDelivered,
      settleFailed,
    } as unknown as OutboundDeliveryService;
    const dispatch = vi.fn(async () => ({
      status: 'sent' as const,
      providerMessageId: 'provider-message-visible',
    }));
    const times = [
      '2026-05-08T00:00:00.000Z',
      '2026-05-08T00:00:00.100Z',
      '2026-05-08T00:00:00.200Z',
      '2026-05-08T00:00:21.000Z',
    ];
    const now = vi.fn(() => times.shift() ?? '2026-05-08T00:00:21.000Z');

    const result = await runBoundedOutboundDeliveryRecovery({
      service,
      appId: 'app:test' as never,
      claimerId: 'runtime-recovery:test',
      batchLimit: 1,
      maxBatches: 3,
      leaseMs: 20_000,
      now,
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(settleSent).toHaveBeenCalledTimes(1);
    expect(settlePartiallyDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: claimed.delivery.id,
        itemId: claimed.item.id,
        claimToken: claimed.item.claimToken,
        error: expect.stringContaining('cannot be retried safely'),
      }),
    );
    expect(claimPending).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      batches: 2,
      claimed: 1,
      sent: 0,
      failed: 1,
      stoppedReason: 'drained',
    });
  });

  it('does not settle sent when dispatch fails closed', async () => {
    const claimed = makeClaimedItem();
    const { service, markDeliveryItemSent, markDeliveryItemFailed } =
      makeService({
        claims: [[claimed], []],
      });

    const before = getOperationalErrorCount('delivery', 'outbound_dispatch');
    const result = await runBoundedOutboundDeliveryRecovery({
      service,
      appId: 'app:test' as never,
      claimerId: 'runtime-recovery:test',
      maxBatches: 2,
      now: () => '2026-05-08T00:00:00.000Z',
      dispatch: vi.fn(async () => ({
        status: 'failed',
        error: 'missing channel',
      })),
    });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(getOperationalErrorCount('delivery', 'outbound_dispatch')).toBe(
      before + 1,
    );
    expect(markDeliveryItemSent).not.toHaveBeenCalled();
    expect(markDeliveryItemFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: claimed.delivery.id,
        itemId: claimed.item.id,
        claimToken: claimed.item.claimToken,
      }),
    );
  });

  it('treats ambiguous durable dispatch errors as partially delivered instead of provider failure', async () => {
    const claimed = makeClaimedItem();
    const {
      service,
      markDeliveryItemSent,
      markDeliveryItemFailed,
      markDeliveryItemPartiallyDelivered,
    } = makeService({
      claims: [[claimed], []],
    });

    const result = await runBoundedOutboundDeliveryRecovery({
      service,
      appId: 'app:test' as never,
      claimerId: 'runtime-recovery:test',
      maxBatches: 2,
      now: () => '2026-05-08T00:00:00.000Z',
      dispatch: vi.fn(async () => {
        throw new AmbiguousDurableDeliveryError({
          provider: 'slack',
          conversationJid: 'sl:C123',
          cause: new Error('sent-status persistence failed'),
        });
      }),
    });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(markDeliveryItemSent).not.toHaveBeenCalled();
    expect(markDeliveryItemFailed).not.toHaveBeenCalled();
    expect(markDeliveryItemPartiallyDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: claimed.delivery.id,
        itemId: claimed.item.id,
        claimToken: claimed.item.claimToken,
        error: expect.stringContaining('cannot be retried safely'),
      }),
    );
  });

  it('falls back to non-retryable ambiguous partial when retry-tail settlement fails, preventing blind resend', async () => {
    const claimed = makeClaimedItem({
      item: {
        id: 'delivery-item:partial-fallback' as never,
      } as never,
    });
    const claimPending = vi
      .fn()
      .mockResolvedValueOnce([claimed])
      .mockResolvedValueOnce([]);
    const settlePartiallyDelivered = vi
      .fn()
      .mockRejectedValueOnce(new Error('retry-tail settlement unavailable'))
      .mockResolvedValueOnce({ applied: true, delivery: null });
    const service = {
      claimPending,
      settleSent: vi.fn(),
      settleFailed: vi.fn(),
      settlePartiallyDelivered,
    } as unknown as OutboundDeliveryService;
    const dispatch = vi.fn(async () => ({
      status: 'partially_delivered' as const,
      error: 'first chunk visible',
      deliveredParts: 1,
      totalParts: 2,
      retryTail: {
        canonicalText: 'unsent suffix',
        providerPayload: { provider: 'slack', chunk: 2 },
      },
    }));

    const result = await runBoundedOutboundDeliveryRecovery({
      service,
      appId: 'app:test' as never,
      claimerId: 'runtime-recovery:test',
      batchLimit: 1,
      maxBatches: 3,
      leaseMs: 20_000,
      now: () => '2026-05-08T00:00:00.000Z',
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(settlePartiallyDelivered).toHaveBeenCalledTimes(2);
    expect(settlePartiallyDelivered).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        itemId: claimed.item.id,
        retryTail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'slack', chunk: 2 },
        },
      }),
    );
    expect(settlePartiallyDelivered).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        itemId: claimed.item.id,
        error: expect.stringContaining('marked non-retryable'),
      }),
    );
    expect(result).toEqual({
      batches: 2,
      claimed: 1,
      sent: 0,
      failed: 1,
      stoppedReason: 'drained',
    });
  });
});

describe('startOutboundDeliveryRecoveryLoop', () => {
  beforeEach(async () => {
    await stopOutboundDeliveryRecoveryLoop();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('eventually claims future retry rows without process restart', async () => {
    const claimed = makeClaimedItem({
      item: {
        id: 'delivery-item:future' as never,
      } as never,
    });
    const claims = [[], [claimed], []] as ClaimedOutboundDeliveryItem[][];
    const { service, claimDueDeliveryItems, markDeliveryItemSent } =
      makeService({
        claims,
      });

    const loop = startOutboundDeliveryRecoveryLoop({
      service,
      appId: 'app:test' as never,
      claimerId: 'runtime-recovery:test',
      intervalMs: 1_000,
      maxBatches: 1,
      now: () => '2026-05-08T00:00:00.000Z',
      dispatch: vi.fn(async () => ({
        status: 'sent',
      })),
    });

    await vi.advanceTimersByTimeAsync(2_200);

    expect(claimDueDeliveryItems).toHaveBeenCalledTimes(3);
    expect(markDeliveryItemSent).toHaveBeenCalledTimes(1);
    expect(loop.isRunning()).toBe(true);

    await loop.stop();
    expect(loop.isRunning()).toBe(false);
  });
});
