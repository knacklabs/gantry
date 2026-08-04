import { hostExecutionSlotHolderId, hostExecutionSlotKey, } from '../../shared/host-capacity.js';
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
export const LIVE_TURN_SLOT_KEY_PREFIX = 'live:messages:';
export function liveTurnSlotKey(workerInstanceId) {
    return `${LIVE_TURN_SLOT_KEY_PREFIX}${workerInstanceId}`;
}
/**
 * Slot holders are scoped to the owning lease generation so a stale owner
 * releasing its hold can never free the slot a recovering owner relies on.
 */
export function liveTurnSlotHolderId(turnId, fencingVersion) {
    return `${turnId}:${fencingVersion}`;
}
function shouldUseHostSlot(capacity) {
    return typeof capacity === 'number';
}
async function acquireInteractiveHostSlots(input) {
    if (!shouldUseHostSlot(input.hostSlotCapacity))
        return true;
    const extraCapacity = input.extraCapacity ?? 0;
    const budgetCapacity = input.hostBudgetCapacity ?? input.hostSlotCapacity;
    if (input.hostSlotCapacity <= 0 || budgetCapacity <= 0)
        return false;
    const holderId = hostExecutionSlotHolderId(input.holderId);
    const budgetAcquired = await input.deps.coordination.acquireRunSlot({
        slotKey: hostExecutionSlotKey(input.workerInstanceId),
        holderId,
        capacity: budgetCapacity + extraCapacity,
        ttlMs: input.ttlMs,
        runId: input.runId,
        workerInstanceId: input.workerInstanceId,
        now: input.now,
    });
    if (!budgetAcquired)
        return false;
    let classAcquired;
    try {
        classAcquired = await input.deps.coordination.acquireRunSlot({
            slotKey: hostExecutionSlotKey(input.workerInstanceId, 'interactive'),
            holderId,
            capacity: input.hostSlotCapacity + extraCapacity,
            ttlMs: input.ttlMs,
            runId: input.runId,
            workerInstanceId: input.workerInstanceId,
            now: input.now,
        });
    }
    catch (err) {
        await releaseInteractiveHostSlots(input);
        throw err;
    }
    if (classAcquired)
        return true;
    await releaseInteractiveHostSlots(input);
    return false;
}
async function releaseInteractiveHostSlots(input) {
    if (!shouldUseHostSlot(input.hostSlotCapacity))
        return;
    const holderId = hostExecutionSlotHolderId(input.holderId);
    await input.deps.coordination.releaseRunSlot({
        slotKey: hostExecutionSlotKey(input.workerInstanceId, 'interactive'),
        holderId,
    });
    await input.deps.coordination.releaseRunSlot({
        slotKey: hostExecutionSlotKey(input.workerInstanceId),
        holderId,
    });
}
async function renewInteractiveHostSlots(input) {
    if (!shouldUseHostSlot(input.hostSlotCapacity))
        return true;
    const holderId = hostExecutionSlotHolderId(input.holderId);
    const budgetHeld = await input.deps.coordination.renewRunSlot({
        slotKey: hostExecutionSlotKey(input.workerInstanceId),
        holderId,
        ttlMs: input.ttlMs,
        now: input.now,
    });
    const classHeld = budgetHeld &&
        (await input.deps.coordination.renewRunSlot({
            slotKey: hostExecutionSlotKey(input.workerInstanceId, 'interactive'),
            holderId,
            ttlMs: input.ttlMs,
            now: input.now,
        }));
    return budgetHeld && classHeld;
}
export function liveTurnFence(lease) {
    return {
        leaseToken: lease.leaseToken,
        workerInstanceId: lease.workerInstanceId,
        fencingVersion: lease.fencingVersion,
    };
}
/**
 * Admission step for a new live turn: acquire a cluster slot, claim the
 * scope, claim the run lease, and project the lease onto the turn. The
 * caller starts the runner only on 'claimed'; on 'scope_active' it must
 * append a continuation command to the existing owner instead.
 */
export async function claimLiveTurnExecution(input) {
    const { deps } = input;
    const slotTtlMs = input.slotTtlMs ?? input.leaseTtlMs;
    const slotKey = liveTurnSlotKey(deps.workerInstanceId);
    const hostSlotCapacity = input.hostSlotCapacity;
    const hostBudgetCapacity = input.hostBudgetCapacity;
    const existing = await deps.liveTurns.getActiveLiveTurn({
        scope: input.scope,
    });
    if (existing)
        return { outcome: 'scope_active', activeTurn: existing };
    // Slot before scope: a capacity deferral must leave no turn behind, so
    // the message simply stays queued until a slot frees up.
    const provisionalHolderId = liveTurnSlotHolderId(input.turnId, 0);
    const provisionalHostAcquired = await acquireInteractiveHostSlots({
        deps,
        holderId: provisionalHolderId,
        hostSlotCapacity,
        hostBudgetCapacity,
        ttlMs: slotTtlMs,
        runId: input.runId,
        workerInstanceId: deps.workerInstanceId,
        now: input.now,
    });
    if (!provisionalHostAcquired)
        return { outcome: 'no_capacity' };
    const slotAcquired = await deps.coordination.acquireRunSlot({
        slotKey,
        holderId: provisionalHolderId,
        capacity: input.slotCapacity,
        ttlMs: slotTtlMs,
        runId: input.runId,
        workerInstanceId: deps.workerInstanceId,
        now: input.now,
    });
    if (!slotAcquired) {
        await releaseInteractiveHostSlots({
            deps,
            holderId: provisionalHolderId,
            hostSlotCapacity,
            workerInstanceId: deps.workerInstanceId,
        });
        return { outcome: 'no_capacity' };
    }
    const turn = await deps.liveTurns.claimLiveTurn({
        id: input.turnId,
        scope: input.scope,
        workerInstanceId: deps.workerInstanceId,
        runId: input.runId,
        pendingMessage: input.pendingMessage,
        stopAliasJids: input.stopAliasJids,
        requiredContinuationUserId: input.requiredContinuationUserId,
        now: input.now,
    });
    if (!turn) {
        await deps.coordination.releaseRunSlot({
            slotKey,
            holderId: provisionalHolderId,
        });
        await releaseInteractiveHostSlots({
            deps,
            holderId: provisionalHolderId,
            hostSlotCapacity,
            workerInstanceId: deps.workerInstanceId,
        });
        const activeTurn = await deps.liveTurns.getActiveLiveTurn({
            scope: input.scope,
        });
        if (activeTurn)
            return { outcome: 'scope_active', activeTurn };
        return { outcome: 'lease_unavailable' };
    }
    const lease = await deps.coordination.claimRunLease({
        runId: input.runId,
        jobId: null,
        workerInstanceId: deps.workerInstanceId,
        ttlMs: input.leaseTtlMs,
        now: input.now,
    });
    if (!lease) {
        await deps.coordination.releaseRunSlot({
            slotKey,
            holderId: provisionalHolderId,
        });
        await releaseInteractiveHostSlots({
            deps,
            holderId: provisionalHolderId,
            hostSlotCapacity,
            workerInstanceId: deps.workerInstanceId,
        });
        await deps.liveTurns.transitionLiveTurnState({
            id: input.turnId,
            toState: 'failed',
            fromStates: ['claimed'],
            now: input.now,
        });
        return { outcome: 'lease_unavailable' };
    }
    // Re-home the slot under the lease generation, then attach the lease
    // projection so the turn carries its owner coordinates.
    const rehomedSlotAcquired = await deps.coordination.acquireRunSlot({
        slotKey,
        holderId: liveTurnSlotHolderId(input.turnId, lease.fencingVersion),
        // The provisional hold below is released in the same step, so allow the
        // re-homed hold to coexist with it momentarily.
        capacity: input.slotCapacity + 1,
        ttlMs: slotTtlMs,
        runId: input.runId,
        workerInstanceId: deps.workerInstanceId,
        now: input.now,
    });
    const releaseClaimedTurn = async (rehomedHostSlotAcquired) => {
        await deps.coordination.settleRunLease({
            runId: input.runId,
            leaseToken: lease.leaseToken,
            workerInstanceId: lease.workerInstanceId,
            fencingVersion: lease.fencingVersion,
            outcome: 'released',
            now: input.now,
        });
        await deps.coordination.releaseRunSlot({
            slotKey,
            holderId: provisionalHolderId,
        });
        if (rehomedSlotAcquired) {
            await deps.coordination.releaseRunSlot({
                slotKey,
                holderId: liveTurnSlotHolderId(input.turnId, lease.fencingVersion),
            });
        }
        await releaseInteractiveHostSlots({
            deps,
            holderId: provisionalHolderId,
            hostSlotCapacity,
            workerInstanceId: deps.workerInstanceId,
        });
        if (rehomedHostSlotAcquired) {
            await releaseInteractiveHostSlots({
                deps,
                holderId: liveTurnSlotHolderId(input.turnId, lease.fencingVersion),
                hostSlotCapacity,
                workerInstanceId: deps.workerInstanceId,
            });
        }
        await deps.liveTurns.transitionLiveTurnState({
            id: input.turnId,
            toState: 'failed',
            fromStates: ['claimed'],
            now: input.now,
        });
    };
    let rehomedHostSlotAcquired;
    try {
        rehomedHostSlotAcquired = await acquireInteractiveHostSlots({
            deps,
            holderId: liveTurnSlotHolderId(input.turnId, lease.fencingVersion),
            hostSlotCapacity,
            hostBudgetCapacity,
            ttlMs: slotTtlMs,
            runId: input.runId,
            workerInstanceId: deps.workerInstanceId,
            now: input.now,
            extraCapacity: 1,
        });
    }
    catch (err) {
        await releaseClaimedTurn(false);
        throw err;
    }
    if (!rehomedSlotAcquired || !rehomedHostSlotAcquired) {
        await releaseClaimedTurn(rehomedHostSlotAcquired);
        return { outcome: 'no_capacity' };
    }
    await deps.coordination.releaseRunSlot({
        slotKey,
        holderId: provisionalHolderId,
    });
    await releaseInteractiveHostSlots({
        deps,
        holderId: provisionalHolderId,
        hostSlotCapacity,
        workerInstanceId: deps.workerInstanceId,
    });
    const attached = await deps.liveTurns.attachLiveTurnLease({
        id: input.turnId,
        runId: input.runId,
        lease: liveTurnFence(lease),
        now: input.now,
    });
    if (!attached) {
        await deps.coordination.settleRunLease({
            runId: input.runId,
            leaseToken: lease.leaseToken,
            workerInstanceId: lease.workerInstanceId,
            fencingVersion: lease.fencingVersion,
            outcome: 'released',
            now: input.now,
        });
        await deps.coordination.releaseRunSlot({
            slotKey,
            holderId: liveTurnSlotHolderId(input.turnId, lease.fencingVersion),
        });
        await releaseInteractiveHostSlots({
            deps,
            holderId: liveTurnSlotHolderId(input.turnId, lease.fencingVersion),
            hostSlotCapacity,
            workerInstanceId: deps.workerInstanceId,
        });
        await deps.liveTurns.transitionLiveTurnState({
            id: input.turnId,
            toState: 'failed',
            fromStates: ['claimed'],
            now: input.now,
        });
        return { outcome: 'lease_unavailable' };
    }
    return { outcome: 'claimed', turn: { ...turn, runId: input.runId }, lease };
}
/** Single heartbeat step: renew the lease and the slot hold together. */
export async function heartbeatLiveTurnLease(input) {
    const { deps } = input;
    const slotKey = liveTurnSlotKey(deps.workerInstanceId);
    const holderId = liveTurnSlotHolderId(input.turnId, input.lease.fencingVersion);
    const leaseAlive = await deps.coordination.heartbeatRunLease({
        runId: input.lease.runId,
        leaseToken: input.lease.leaseToken,
        ttlMs: input.leaseTtlMs,
        now: input.now,
    });
    const slotTtlMs = input.slotTtlMs ?? input.leaseTtlMs;
    const slotHeld = leaseAlive &&
        (await deps.coordination.renewRunSlot({
            slotKey,
            holderId,
            ttlMs: slotTtlMs,
            now: input.now,
        }));
    const hostSlotHeld = leaseAlive &&
        (await renewInteractiveHostSlots({
            deps,
            holderId,
            hostSlotCapacity: input.hostSlotCapacity,
            ttlMs: slotTtlMs,
            workerInstanceId: deps.workerInstanceId,
            now: input.now,
        }));
    if (!leaseAlive || !slotHeld || !hostSlotHeld) {
        await deps.coordination.releaseRunSlot({ slotKey, holderId });
        await releaseInteractiveHostSlots({
            deps,
            holderId,
            hostSlotCapacity: input.hostSlotCapacity,
            workerInstanceId: deps.workerInstanceId,
        });
    }
    return { leaseAlive, slotHeld: slotHeld && hostSlotHeld };
}
/**
 * Fenced terminal settlement. Returns false when the lease was lost to a
 * recovering worker — the stale owner must drop all terminal writes. The
 * caller's slot hold is released either way.
 */
export async function finalizeLiveTurnExecution(input) {
    const { deps } = input;
    const slotKey = liveTurnSlotKey(deps.workerInstanceId);
    const holderId = liveTurnSlotHolderId(input.turnId, input.fence.fencingVersion);
    try {
        return await deps.liveTurns.finalizeLiveTurnWithLease({
            id: input.turnId,
            turnState: input.turnState,
            leaseOutcome: input.leaseOutcome,
            fence: input.fence,
            agentRunCompletion: input.agentRunCompletion,
            requireNoPendingCommands: true,
            now: input.now,
        });
    }
    finally {
        await deps.coordination.releaseRunSlot({
            slotKey,
            holderId,
        });
        await releaseInteractiveHostSlots({
            deps,
            holderId,
            hostSlotCapacity: input.hostSlotCapacity,
            workerInstanceId: deps.workerInstanceId,
        });
    }
}
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
export async function recoverLiveTurnExecution(input) {
    const { deps } = input;
    const slotKey = liveTurnSlotKey(deps.workerInstanceId);
    if (!input.turn.runId)
        return { outcome: 'turn_gone' };
    if (input.isEligible && !(await input.isEligible(input.turn))) {
        return { outcome: 'ineligible' };
    }
    const lease = await deps.coordination.claimRunLease({
        runId: input.turn.runId,
        jobId: null,
        workerInstanceId: deps.workerInstanceId,
        ttlMs: input.leaseTtlMs,
        now: input.now,
    });
    if (!lease)
        return { outcome: 'lease_unavailable' };
    const release = async () => {
        await deps.coordination.settleRunLease({
            runId: input.turn.runId,
            leaseToken: lease.leaseToken,
            workerInstanceId: lease.workerInstanceId,
            fencingVersion: lease.fencingVersion,
            outcome: 'released',
            now: input.now,
        });
    };
    const slotAcquired = await deps.coordination.acquireRunSlot({
        slotKey,
        holderId: liveTurnSlotHolderId(input.turn.id, lease.fencingVersion),
        capacity: input.slotCapacity,
        ttlMs: input.slotTtlMs ?? input.leaseTtlMs,
        runId: input.turn.runId,
        workerInstanceId: deps.workerInstanceId,
        now: input.now,
    });
    if (!slotAcquired) {
        await release();
        return { outcome: 'no_capacity' };
    }
    const holderId = liveTurnSlotHolderId(input.turn.id, lease.fencingVersion);
    let hostSlotAcquired;
    try {
        hostSlotAcquired = await acquireInteractiveHostSlots({
            deps,
            holderId,
            hostSlotCapacity: input.hostSlotCapacity,
            hostBudgetCapacity: input.hostBudgetCapacity,
            ttlMs: input.slotTtlMs ?? input.leaseTtlMs,
            runId: input.turn.runId,
            workerInstanceId: deps.workerInstanceId,
            now: input.now,
        });
    }
    catch (err) {
        await release();
        await deps.coordination.releaseRunSlot({
            slotKey,
            holderId,
        });
        throw err;
    }
    if (!hostSlotAcquired) {
        await release();
        await deps.coordination.releaseRunSlot({
            slotKey,
            holderId,
        });
        return { outcome: 'no_capacity' };
    }
    const takenOver = await deps.liveTurns.takeOverLiveTurn({
        id: input.turn.id,
        lease: liveTurnFence(lease),
        now: input.now,
    });
    if (!takenOver) {
        await release();
        await deps.coordination.releaseRunSlot({
            slotKey,
            holderId,
        });
        await releaseInteractiveHostSlots({
            deps,
            holderId,
            hostSlotCapacity: input.hostSlotCapacity,
            workerInstanceId: deps.workerInstanceId,
        });
        return { outcome: 'turn_gone' };
    }
    return { outcome: 'recovered', lease };
}
