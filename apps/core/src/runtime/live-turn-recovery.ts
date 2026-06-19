import type { LiveTurn } from '../domain/ports/live-turns.js';
import type { RunLease } from '../domain/ports/worker-coordination.js';
import {
  finalizeLiveTurnExecution,
  liveTurnFence,
  recoverLiveTurnExecution,
  type LiveTurnLeaseDeps,
} from '../application/live-turns/live-turn-lease-service.js';
import {
  nowMs as currentTimeMs,
  parseIso,
  toIso,
} from '../shared/time/datetime.js';

/**
 * Bounded recovery sweep for live turns whose owner stopped heartbeating.
 * Turns with an expired run lease are reclaimed at a strictly higher
 * fencing version and handed to `resumeRecoveredTurn`; turns that never
 * attached a lease (claim crashed mid-admission) are settled 'timed_out'
 * so their scope frees up.
 */

export interface LiveTurnRecoveryTickResult {
  recovered: number;
  timedOut: number;
  /** Recovery stopped early because this worker has no live capacity. */
  capacityExhausted: boolean;
  /** Turns this worker skipped because it is ineligible for their capabilities. */
  ineligible: number;
  /** Turns with no eligible recoverer in the fleet; a starvation alert fired. */
  noEligibleRecoverer: number;
}

export async function runLiveTurnRecoveryTick(input: {
  deps: LiveTurnLeaseDeps;
  /**
   * Restart or reattach the runner for a recovered turn. A thrown error
   * settles the turn 'failed' under the new lease — recovery never leaves
   * a claimed-but-dead owner behind.
   */
  resumeRecoveredTurn: (args: {
    turn: LiveTurn;
    lease: RunLease;
  }) => Promise<void>;
  onTurnTimedOut?: (turn: LiveTurn) => Promise<void> | void;
  /**
   * Capability-matched recovery gate (fleet mode): whether THIS worker may
   * recover `turn`. Absent ⇒ always eligible (single-worker (workstation)
   * deployment — unchanged).
   */
  isEligible?: (turn: LiveTurn) => boolean | Promise<boolean>;
  /**
   * Invoked when a turn is recoverable but THIS worker is ineligible AND no
   * active worker is eligible to recover it ("recoverable but no eligible
   * recoverer"). Emits the capability-starvation alert instead of livelocking.
   */
  onNoEligibleRecoverer?: (turn: LiveTurn) => Promise<void> | void;
  slotCapacity: number;
  hostSlotCapacity?: number;
  hostBudgetCapacity?: number;
  leaseTtlMs: number;
  /** How long an unleased claim may sit before it is timed out. */
  unleasedStaleMs: number;
  batchLimit?: number;
  now?: string;
  warn?: (context: Record<string, unknown>, message: string) => void;
}): Promise<LiveTurnRecoveryTickResult> {
  const warn = input.warn ?? (() => undefined);
  const nowMsValue = input.now
    ? parseIso(input.now)?.getTime()
    : currentTimeMs();
  if (nowMsValue === undefined) {
    throw new Error(`Invalid date input: ${input.now}`);
  }
  const unleasedStaleBefore = toIso(nowMsValue - input.unleasedStaleMs);
  const candidates = await input.deps.liveTurns.listRecoverableLiveTurns({
    unleasedStaleBefore,
    limit: Math.max(1, input.batchLimit ?? 16),
    now: input.now,
  });
  const result: LiveTurnRecoveryTickResult = {
    recovered: 0,
    timedOut: 0,
    capacityExhausted: false,
    ineligible: 0,
    noEligibleRecoverer: 0,
  };
  for (const turn of candidates) {
    if (
      !turn.runId ||
      !turn.leaseToken ||
      turn.fencingVersion === null ||
      turn.workerInstanceId === null
    ) {
      // The admission crashed before a lease existed; nothing to resume.
      const timedOut = await input.deps.liveTurns.transitionLiveTurnState({
        id: turn.id,
        toState: 'timed_out',
        fromStates: [turn.state],
        agentRunCompletion: turn.runId
          ? {
              status: 'failed',
              errorSummary:
                'Live turn timed out before a worker lease was attached.',
            }
          : null,
        now: input.now,
      });
      if (timedOut) {
        result.timedOut += 1;
        await input.onTurnTimedOut?.(turn);
      }
      continue;
    }
    const recovery = await recoverLiveTurnExecution({
      deps: input.deps,
      turn,
      slotCapacity: input.slotCapacity,
      hostSlotCapacity: input.hostSlotCapacity,
      hostBudgetCapacity: input.hostBudgetCapacity,
      leaseTtlMs: input.leaseTtlMs,
      isEligible: input.isEligible,
      now: input.now,
    });
    if (recovery.outcome === 'no_capacity') {
      result.capacityExhausted = true;
      break;
    }
    if (recovery.outcome === 'ineligible') {
      // This worker cannot run the turn. If no active worker is eligible, the
      // turn is recoverable-but-stranded ⇒ alert instead of livelocking. The
      // fleet-wide eligibility decision is the caller's (onNoEligibleRecoverer
      // only fires when it has confirmed no eligible recoverer exists).
      result.ineligible += 1;
      if (input.onNoEligibleRecoverer) {
        await input.onNoEligibleRecoverer(turn);
        result.noEligibleRecoverer += 1;
      }
      continue;
    }
    if (recovery.outcome !== 'recovered') continue;
    result.recovered += 1;
    try {
      await input.resumeRecoveredTurn({ turn, lease: recovery.lease });
    } catch (err) {
      warn(
        { err, turnId: turn.id, runId: turn.runId },
        'Failed to resume recovered live turn; settling as failed',
      );
      await finalizeLiveTurnExecution({
        deps: input.deps,
        turnId: turn.id,
        fence: liveTurnFence(recovery.lease),
        turnState: 'failed',
        leaseOutcome: 'failed',
        hostSlotCapacity: input.hostSlotCapacity,
        hostBudgetCapacity: input.hostBudgetCapacity,
        agentRunCompletion: {
          status: 'failed',
          errorSummary: 'Recovered live turn failed to resume.',
        },
        now: input.now,
      });
    }
  }
  return result;
}

export interface LiveTurnRecoveryLoop {
  stop(): void;
}

export function startLiveTurnRecoveryLoop(input: {
  intervalMs: number;
  tick: () => Promise<LiveTurnRecoveryTickResult>;
  warn?: (context: Record<string, unknown>, message: string) => void;
}): LiveTurnRecoveryLoop {
  let stopped = false;
  let running = false;
  const timer = setInterval(
    () => {
      if (stopped || running) return;
      running = true;
      void input
        .tick()
        .catch((err) => input.warn?.({ err }, 'Live turn recovery tick failed'))
        .finally(() => {
          running = false;
        });
    },
    Math.max(1_000, input.intervalMs),
  );
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
