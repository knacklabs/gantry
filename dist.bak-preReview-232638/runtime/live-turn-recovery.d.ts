import type { LiveTurn } from '../domain/ports/live-turns.js';
import type { RunLease } from '../domain/ports/worker-coordination.js';
import { type LiveTurnLeaseDeps } from '../application/live-turns/live-turn-lease-service.js';
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
export declare function runLiveTurnRecoveryTick(input: {
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
}): Promise<LiveTurnRecoveryTickResult>;
export interface LiveTurnRecoveryLoop {
    stop(): void;
}
export declare function startLiveTurnRecoveryLoop(input: {
    intervalMs: number;
    tick: () => Promise<LiveTurnRecoveryTickResult>;
    warn?: (context: Record<string, unknown>, message: string) => void;
}): LiveTurnRecoveryLoop;
