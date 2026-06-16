import { randomUUID } from 'node:crypto';

import type { LiveAdmissionWorkItemRepository } from '../domain/ports/live-turns.js';
import { nowMs, toIso } from '../shared/time/datetime.js';
import {
  processLiveAdmissionWorkItem,
  type MessageLoopDeps,
  type MessageAdmissionProcessingResult,
} from './message-loop.js';

type WarnLog = (context: Record<string, unknown>, message: string) => void;

export interface LiveAdmissionWorkLoopHandle {
  /** Stop the loop after the in-flight claim batch. */
  stop: () => void;
  /** Wake the loop early; LISTEN/NOTIFY callers use this as a hint only. */
  trigger: () => void;
  /** Settles when the loop exits. */
  done: Promise<void>;
}

export interface StartLiveAdmissionWorkLoopInput {
  liveAdmissions: LiveAdmissionWorkItemRepository;
  workerInstanceId: string;
  messageLoopDeps: MessageLoopDeps;
  claimLimit?: number;
  claimTtlMs?: number;
  intervalMs?: number;
  maxBatchesPerWake?: number;
  warn: WarnLog;
}

const DEFAULT_CLAIM_LIMIT = 25;
const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_MAX_BATCHES_PER_WAKE = 10;

function deferReasonForResult(
  result: Exclude<MessageAdmissionProcessingResult, 'completed'>,
): 'queued_capacity' | 'listener_degraded' {
  return result;
}

function deferDelayMs(
  result: Exclude<MessageAdmissionProcessingResult, 'completed'> | 'retry',
): number {
  if (result === 'queued_capacity') return 1_000;
  if (result === 'listener_degraded') return 3_000;
  return 5_000;
}

export function startLiveAdmissionWorkLoop(
  input: StartLiveAdmissionWorkLoopInput,
): LiveAdmissionWorkLoopHandle {
  const claimLimit = input.claimLimit ?? DEFAULT_CLAIM_LIMIT;
  const claimTtlMs = input.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxBatchesPerWake =
    input.maxBatchesPerWake ?? DEFAULT_MAX_BATCHES_PER_WAKE;
  let stopped = false;
  let cancelDelay: (() => void) | undefined;

  const deferClaim = async (
    itemId: string,
    claimToken: string,
    result: Exclude<MessageAdmissionProcessingResult, 'completed'> | 'retry',
  ): Promise<void> => {
    const reason = result === 'retry' ? 'retry' : deferReasonForResult(result);
    const ok = await input.liveAdmissions.deferLiveAdmissionWorkItem({
      id: itemId,
      claimToken,
      workerInstanceId: input.workerInstanceId,
      reason,
      deferUntil: toIso(nowMs() + deferDelayMs(result)),
    });
    if (!ok) {
      input.warn(
        { itemId, reason },
        'Failed to defer live admission work item claim',
      );
    }
  };

  const drainOnce = async (): Promise<void> => {
    for (let batch = 0; batch < maxBatchesPerWake && !stopped; batch++) {
      const claimToken = `live-admission:${input.workerInstanceId}:${randomUUID()}`;
      const claimed = await input.liveAdmissions.claimLiveAdmissionWorkItems({
        workerInstanceId: input.workerInstanceId,
        claimToken,
        claimExpiresAt: toIso(nowMs() + claimTtlMs),
        limit: claimLimit,
      });
      if (claimed.length === 0) return;

      for (const item of claimed) {
        if (stopped) return;
        try {
          const result = await processLiveAdmissionWorkItem(
            input.messageLoopDeps,
            item,
          );
          if (result === 'completed') {
            const ok = await input.liveAdmissions.settleLiveAdmissionWorkItem({
              id: item.id,
              claimToken,
              workerInstanceId: input.workerInstanceId,
              state: 'completed',
            });
            if (!ok) {
              input.warn(
                { itemId: item.id },
                'Failed to settle live admission work item claim',
              );
            }
            continue;
          }
          await deferClaim(item.id, claimToken, result);
        } catch (err) {
          input.warn(
            { err, itemId: item.id },
            'Live admission work item processing failed; deferring retry',
          );
          await deferClaim(item.id, claimToken, 'retry');
        }
      }

      if (claimed.length < claimLimit) return;
    }
  };

  const done = (async () => {
    while (!stopped) {
      try {
        await drainOnce();
      } catch (err) {
        input.warn(
          { err },
          'Live admission work loop failed to claim durable work items',
        );
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          cancelDelay = undefined;
          resolve();
        }, intervalMs);
        cancelDelay = () => {
          cancelDelay = undefined;
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();

  return {
    stop: () => {
      stopped = true;
      cancelDelay?.();
    },
    trigger: () => {
      cancelDelay?.();
    },
    done,
  };
}
