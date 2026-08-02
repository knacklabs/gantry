import type { LiveTurn, LiveTurnAgentRunCompletion, LiveTurnCoordinationRepository, LiveTurnLeaseFence, LiveTurnScope } from '../../domain/ports/live-turns.js';
import type { RunLease, RunLeaseRepository, RunSlotRepository } from '../../domain/ports/worker-coordination.js';
/**
 * Live lease lifecycle on top of the durable live-turn contract. Reuses the
 * job-worker primitives: run_leases is the fencing authority (live leases
 * carry jobId = null) and per-worker run_slots bound live message concurrency
 * instead of process-local counters.
 */
/**
 * Slot keys are per-live-worker (`live:messages:<workerInstanceId>`), so
 * `runtime.queue.max_message_runs` bounds the concurrent live turns ON EACH
 * live worker rather than cluster-wide. In workstation mode the single worker
 * is the only holder, so the bound is identical to before. Recovery acquires
 * under the RECOVERING worker's key; a dead owner's slot rows expire by TTL and
 * are GC'd on the next acquire under that key. The prefix is exported for WP3
 * cluster-usage queries (per-worker active-turn counts).
 */
export declare const LIVE_TURN_SLOT_KEY_PREFIX = "live:messages:";
export declare function liveTurnSlotKey(workerInstanceId: string): string;
export type LiveTurnCoordination = Pick<RunLeaseRepository, 'claimRunLease' | 'heartbeatRunLease' | 'settleRunLease'> & RunSlotRepository;
export interface LiveTurnLeaseDeps {
    liveTurns: LiveTurnCoordinationRepository;
    coordination: LiveTurnCoordination;
    workerInstanceId: string;
}
/**
 * Slot holders are scoped to the owning lease generation so a stale owner
 * releasing its hold can never free the slot a recovering owner relies on.
 */
export declare function liveTurnSlotHolderId(turnId: string, fencingVersion: number): string;
export declare function liveTurnFence(lease: RunLease): LiveTurnLeaseFence;
export type LiveTurnClaimResult = {
    outcome: 'claimed';
    turn: LiveTurn;
    lease: RunLease;
} | {
    outcome: 'scope_active';
    activeTurn: LiveTurn;
} | {
    outcome: 'no_capacity';
} | {
    outcome: 'lease_unavailable';
};
/**
 * Admission step for a new live turn: acquire a cluster slot, claim the
 * scope, claim the run lease, and project the lease onto the turn. The
 * caller starts the runner only on 'claimed'; on 'scope_active' it must
 * append a continuation command to the existing owner instead.
 */
export declare function claimLiveTurnExecution(input: {
    deps: LiveTurnLeaseDeps;
    turnId: string;
    scope: LiveTurnScope;
    runId: string;
    slotCapacity: number;
    hostSlotCapacity?: number;
    hostBudgetCapacity?: number;
    leaseTtlMs: number;
    slotTtlMs?: number;
    pendingMessage?: Record<string, unknown> | null;
    stopAliasJids?: string[];
    requiredContinuationUserId?: string | null;
    now?: string;
}): Promise<LiveTurnClaimResult>;
export interface LiveTurnHeartbeatResult {
    leaseAlive: boolean;
    slotHeld: boolean;
}
/** Single heartbeat step: renew the lease and the slot hold together. */
export declare function heartbeatLiveTurnLease(input: {
    deps: LiveTurnLeaseDeps;
    turnId: string;
    lease: Pick<RunLease, 'runId' | 'leaseToken' | 'fencingVersion'>;
    leaseTtlMs: number;
    hostSlotCapacity?: number;
    hostBudgetCapacity?: number;
    slotTtlMs?: number;
    now?: string;
}): Promise<LiveTurnHeartbeatResult>;
/**
 * Fenced terminal settlement. Returns false when the lease was lost to a
 * recovering worker — the stale owner must drop all terminal writes. The
 * caller's slot hold is released either way.
 */
export declare function finalizeLiveTurnExecution(input: {
    deps: LiveTurnLeaseDeps;
    turnId: string;
    fence: LiveTurnLeaseFence;
    turnState: 'completed' | 'failed' | 'timed_out';
    leaseOutcome: 'completed' | 'failed' | 'released';
    agentRunCompletion?: LiveTurnAgentRunCompletion | null;
    hostSlotCapacity?: number;
    hostBudgetCapacity?: number;
    now?: string;
}): Promise<boolean>;
export type LiveTurnRecoveryResult = {
    outcome: 'recovered';
    lease: RunLease;
} | {
    outcome: 'lease_unavailable';
} | {
    outcome: 'no_capacity';
} | {
    outcome: 'ineligible';
} | {
    outcome: 'turn_gone';
};
/**
 * Recovery takeover for a turn whose owner stopped heartbeating: reclaim
 * the run lease at a strictly higher fencing version, hold a slot under the
 * new generation, and stamp the turn 'recovered'. Late writes from the old
 * owner are fenced out by run_leases.
 *
 * `isEligible` is an optional capability-matched dispatch gate (fleet mode):
 * when provided and it resolves false, this worker does NOT claim the lease and
 * returns 'ineligible' so a worker that can run the turn recovers it instead.
 * Absent ⇒ always eligible (single-worker (workstation) deployment — unchanged).
 */
export declare function recoverLiveTurnExecution(input: {
    deps: LiveTurnLeaseDeps;
    turn: LiveTurn;
    slotCapacity: number;
    hostSlotCapacity?: number;
    hostBudgetCapacity?: number;
    leaseTtlMs: number;
    slotTtlMs?: number;
    isEligible?: (turn: LiveTurn) => boolean | Promise<boolean>;
    now?: string;
}): Promise<LiveTurnRecoveryResult>;
