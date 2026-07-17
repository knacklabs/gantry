import type { OutboundDeliveryService } from '../application/outbound-delivery/outbound-delivery-service.js';
import {
  getPartialMessageDeliveryMetadata,
  isPartialMessageDeliveryError,
} from '../domain/messages/partial-delivery.js';
import { isAmbiguousDurableDeliveryError } from '../domain/messages/durable-delivery.js';
import type {
  ClaimedOutboundDeliveryItem,
  OutboundDelivery,
} from '../domain/outbound-delivery/outbound-delivery.js';
import { nowIso } from '../shared/time/datetime.js';
import { incrementOperationalError } from '../shared/operational-error-counters.js';

export interface OutboundDeliveryPartialRetryTail {
  canonicalText: string;
  providerPayload?: unknown;
}

export type OutboundDeliveryDispatchResult =
  | {
      status: 'sent';
      providerMessageId?: string;
      providerPayload?: unknown;
    }
  | {
      status: 'failed';
      error?: string;
    }
  | {
      status: 'partially_delivered';
      error?: string;
      deliveredParts?: number;
      totalParts?: number;
      retryTail?: OutboundDeliveryPartialRetryTail;
    };

export interface OutboundDeliveryRecoveryResult {
  batches: number;
  claimed: number;
  sent: number;
  failed: number;
  stoppedReason: 'drained' | 'max_batches';
}

export interface OutboundDeliveryRecoveryInput {
  service: OutboundDeliveryService;
  appId?: OutboundDelivery['appId'];
  claimerId: string;
  dispatch: (
    claimed: ClaimedOutboundDeliveryItem,
  ) => Promise<OutboundDeliveryDispatchResult>;
  batchLimit?: number;
  leaseMs?: number;
  maxBatches?: number;
  now?: () => string;
  receiptIdempotencyKeyForItem?: (
    claimed: ClaimedOutboundDeliveryItem,
  ) => string;
  warn?: (meta: Record<string, unknown>, message: string) => void;
}

export interface OutboundDeliveryRecoveryLoopController {
  isRunning: () => boolean;
  stop: () => Promise<void>;
}

let activeRecoveryLoop: OutboundDeliveryRecoveryLoopController | null = null;

export async function runBoundedOutboundDeliveryRecovery(
  input: OutboundDeliveryRecoveryInput,
): Promise<OutboundDeliveryRecoveryResult> {
  const batchLimit = Math.max(1, input.batchLimit ?? 20);
  const leaseMs = Math.max(1_000, input.leaseMs ?? 15_000);
  const maxBatches = Math.max(1, input.maxBatches ?? 5);
  const now = input.now ?? (() => nowIso());

  let batches = 0;
  let claimedTotal = 0;
  let sent = 0;
  let failed = 0;
  const settleAmbiguousNonRetryable = async (inputSettle: {
    claimed: ClaimedOutboundDeliveryItem;
    claimToken: string;
    error: string;
    partialAt: string;
    warnMessage: string;
  }): Promise<boolean> => {
    try {
      const ambiguous = await input.service.settlePartiallyDelivered({
        deliveryId: inputSettle.claimed.delivery.id,
        itemId: inputSettle.claimed.item.id,
        claimToken: inputSettle.claimToken,
        error: inputSettle.error,
        partialAt: inputSettle.partialAt,
      });
      if (!ambiguous.applied) {
        incrementOperationalError('delivery', 'ambiguous_settlement');
        input.warn?.(
          {
            deliveryId: inputSettle.claimed.delivery.id,
            itemId: inputSettle.claimed.item.id,
          },
          `${inputSettle.warnMessage}; ambiguous settlement was not applied`,
        );
        return false;
      }
      failed += 1;
      return true;
    } catch (err) {
      incrementOperationalError('delivery', 'ambiguous_settlement');
      input.warn?.(
        {
          err,
          deliveryId: inputSettle.claimed.delivery.id,
          itemId: inputSettle.claimed.item.id,
        },
        `${inputSettle.warnMessage}; ambiguous settlement threw`,
      );
      return false;
    }
  };

  while (batches < maxBatches) {
    batches += 1;
    const claimed = input.appId
      ? await input.service.claimPending({
          appId: input.appId,
          claimerId: input.claimerId,
          limit: batchLimit,
          leaseMs,
          now: now(),
        })
      : await input.service.claimPendingAcrossApps({
          claimerId: input.claimerId,
          limit: batchLimit,
          leaseMs,
          now: now(),
        });
    if (claimed.length === 0) {
      return {
        batches,
        claimed: claimedTotal,
        sent,
        failed,
        stoppedReason: 'drained',
      };
    }

    claimedTotal += claimed.length;
    for (const claimedItem of claimed) {
      const claimToken = claimedItem.item.claimToken;
      if (!claimToken) {
        input.warn?.(
          {
            deliveryId: claimedItem.delivery.id,
            itemId: claimedItem.item.id,
          },
          'Skipping outbound delivery item because claim token is missing',
        );
        continue;
      }

      let dispatchResult: OutboundDeliveryDispatchResult;
      let dispatchThrew = false;
      try {
        dispatchResult = await input.dispatch(claimedItem);
      } catch (err) {
        dispatchThrew = true;
        incrementOperationalError('delivery', 'outbound_dispatch');
        if (isPartialMessageDeliveryError(err)) {
          const partialMetadata = getPartialMessageDeliveryMetadata(err);
          dispatchResult = {
            status: 'partially_delivered',
            error: err.message,
            deliveredParts: partialMetadata.deliveredParts,
            totalParts: partialMetadata.totalParts,
            retryTail: partialMetadata.retryTail,
          };
        } else if (isAmbiguousDurableDeliveryError(err)) {
          dispatchResult = {
            status: 'partially_delivered',
            error:
              `Outbound delivery may already be visible and cannot be retried safely. ${err.message}`.trim(),
          };
        } else {
          const message = err instanceof Error ? err.message : String(err);
          input.warn?.(
            {
              err,
              deliveryId: claimedItem.delivery.id,
              itemId: claimedItem.item.id,
            },
            'Outbound delivery dispatch failed with exception',
          );
          dispatchResult = {
            status: 'failed',
            error: message,
          };
        }
      }

      if (dispatchResult.status === 'failed' && !dispatchThrew) {
        incrementOperationalError('delivery', 'outbound_dispatch');
      }

      if (dispatchResult.status === 'sent') {
        let settledError: string | null = null;
        try {
          const settled = await input.service.settleSent({
            deliveryId: claimedItem.delivery.id,
            itemId: claimedItem.item.id,
            claimToken,
            receiptIdempotencyKey:
              input.receiptIdempotencyKeyForItem?.(claimedItem) ??
              String(claimedItem.item.id),
            providerMessageId: dispatchResult.providerMessageId,
            providerPayload: dispatchResult.providerPayload,
            sentAt: now(),
          });
          if (settled.applied) {
            sent += 1;
            continue;
          }
          incrementOperationalError('delivery', 'sent_settlement');
          settledError =
            'Outbound delivery dispatch succeeded but sent settlement was not applied.';
        } catch (err) {
          incrementOperationalError('delivery', 'sent_settlement');
          settledError =
            err instanceof Error
              ? err.message
              : 'Outbound delivery sent settlement threw a non-Error rejection.';
          input.warn?.(
            {
              err,
              deliveryId: claimedItem.delivery.id,
              itemId: claimedItem.item.id,
            },
            'Outbound delivery sent settlement failed after visible send',
          );
        }
        await settleAmbiguousNonRetryable({
          claimed: claimedItem,
          claimToken,
          error:
            `Outbound delivery may already be visible and cannot be retried safely. ${settledError}`.trim(),
          partialAt: now(),
          warnMessage:
            'Outbound delivery ambiguous post-send settlement failed',
        });
        continue;
      }

      if (dispatchResult.status === 'partially_delivered') {
        const partialError =
          dispatchResult.error?.trim() ||
          'Outbound delivery was partially delivered and cannot be safely retried in full.';
        try {
          const settled = await input.service.settlePartiallyDelivered({
            deliveryId: claimedItem.delivery.id,
            itemId: claimedItem.item.id,
            claimToken,
            error: partialError,
            partialAt: now(),
            deliveredParts: dispatchResult.deliveredParts,
            totalParts: dispatchResult.totalParts,
            retryTail: dispatchResult.retryTail,
          });
          if (settled.applied) {
            failed += 1;
            continue;
          }
          incrementOperationalError('delivery', 'partial_settlement');
          await settleAmbiguousNonRetryable({
            claimed: claimedItem,
            claimToken,
            error: `${partialError} Durable partial retry-tail settlement was not applied, so delivery is marked non-retryable to avoid blind resend of visible content.`,
            partialAt: now(),
            warnMessage:
              'Outbound delivery partial retry-tail settlement was not applied',
          });
        } catch (err) {
          incrementOperationalError('delivery', 'partial_settlement');
          input.warn?.(
            {
              err,
              deliveryId: claimedItem.delivery.id,
              itemId: claimedItem.item.id,
            },
            'Outbound delivery partial retry-tail settlement threw',
          );
          await settleAmbiguousNonRetryable({
            claimed: claimedItem,
            claimToken,
            error: `${partialError} Durable partial retry-tail settlement threw, so delivery is marked non-retryable to avoid blind resend of visible content.`,
            partialAt: now(),
            warnMessage:
              'Outbound delivery partial retry-tail settlement fallback failed',
          });
        }
        continue;
      }

      const settled = await input.service.settleFailed({
        deliveryId: claimedItem.delivery.id,
        itemId: claimedItem.item.id,
        claimToken,
        error:
          dispatchResult.error?.trim() ||
          'Outbound delivery dispatch failed without an explicit error.',
        failedAt: now(),
      });
      if (settled.applied) failed += 1;
    }
  }

  return {
    batches,
    claimed: claimedTotal,
    sent,
    failed,
    stoppedReason: 'max_batches',
  };
}

export function startOutboundDeliveryRecoveryLoop(
  input: OutboundDeliveryRecoveryInput & {
    intervalMs?: number;
  },
): OutboundDeliveryRecoveryLoopController {
  if (activeRecoveryLoop) {
    return activeRecoveryLoop;
  }

  const intervalMs = Math.max(250, input.intervalMs ?? 5_000);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  const runOnce = async () => {
    try {
      await runBoundedOutboundDeliveryRecovery(input);
    } catch (err) {
      input.warn?.(
        {
          err,
          appId: input.appId ?? 'all-apps',
          claimerId: input.claimerId,
        },
        'Outbound delivery recovery loop run failed',
      );
    }
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped || running) return;
    running = runOnce().finally(() => {
      running = undefined;
      schedule(intervalMs);
    });
    await running;
  };

  const controller: OutboundDeliveryRecoveryLoopController = {
    isRunning: () => !stopped,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await running;
      if (activeRecoveryLoop === controller) {
        activeRecoveryLoop = null;
      }
    },
  };

  activeRecoveryLoop = controller;
  void tick();
  return controller;
}

export async function stopOutboundDeliveryRecoveryLoop(): Promise<void> {
  await activeRecoveryLoop?.stop();
}
