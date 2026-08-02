import { claimLiveTurnExecution, finalizeLiveTurnExecution, heartbeatLiveTurnLease, liveTurnFence, liveTurnSlotHolderId, liveTurnSlotKey, } from '../application/live-turns/live-turn-lease-service.js';
import { createLiveTurnCommandPump, } from './live-turn-command-pump.js';
import { routeLiveCloseStdin, routeLiveContinuation, routeLiveStop, } from './live-turn-routing.js';
import { writeResolvedInteractionResponse } from './interaction-resolution-response.js';
import { hostExecutionSlotHolderId, hostExecutionSlotKey, } from '../shared/host-capacity.js';
export class LiveTurnAuthority {
    deps;
    active = new Map();
    unsubscribeCommandWakeup;
    draining = false;
    constructor(deps) {
        this.deps = deps;
        this.unsubscribeCommandWakeup = deps.commandWakeupSource?.subscribe(() => {
            this.tickActiveQueues();
        });
    }
    /**
     * Stop admitting new live turns during graceful drain. Already-active turns
     * keep running to completion; only fresh admissions are rejected so the run
     * is recovered by the successor live host.
     */
    beginDraining() {
        this.draining = true;
    }
    get leaseTtlMs() {
        return this.deps.leaseTtlMs ?? 60_000;
    }
    warn(context, message) {
        this.deps.warn?.(context, message);
    }
    /**
     * Cheap durable pre-check used before minting an agent run row: with N
     * pollers, the common case is that another worker already owns the scope, so
     * the caller can route a continuation instead of creating an orphan run.
     */
    getActiveLiveTurn(scope) {
        return this.deps.leaseDeps.liveTurns.getActiveLiveTurn({ scope });
    }
    /** Whether this worker currently owns the live turn for `queueJid`. */
    ownsQueue(queueJid) {
        return this.active.has(queueJid);
    }
    ownedRunId(queueJid) {
        return this.active.get(queueJid)?.runId || null;
    }
    ownedFence(queueJid) {
        return this.active.get(queueJid)?.fence ?? null;
    }
    /**
     * Admission for a new live message turn. On 'claimed', the caller starts
     * the runner and must call registerLocalRunner + finalize. On
     * 'scope_active', the message must be routed as a continuation instead.
     */
    async admit(input) {
        // While draining, refuse new admissions; the released host lease lets a
        // successor claim and recover the turn at a higher fencing version.
        if (this.draining)
            return { outcome: 'lease_unavailable' };
        const claim = await claimLiveTurnExecution({
            deps: this.deps.leaseDeps,
            turnId: input.turnId,
            scope: input.scope,
            runId: input.runId,
            slotCapacity: this.deps.slotCapacity(),
            hostSlotCapacity: this.deps.hostSlotCapacity?.(),
            hostBudgetCapacity: this.deps.hostBudgetCapacity?.(),
            leaseTtlMs: this.leaseTtlMs,
            pendingMessage: input.pendingMessage,
            stopAliasJids: input.stopAliasJids,
            requiredContinuationUserId: input.requiredContinuationUserId,
        });
        if (claim.outcome !== 'claimed')
            return { outcome: claim.outcome };
        const fence = liveTurnFence(claim.lease);
        this.registerActiveTurn(input.queueJid, {
            turnId: input.turnId,
            runId: input.runId,
            scope: input.scope,
            fence,
        });
        return { outcome: 'claimed', turn: claim.turn, fence };
    }
    /**
     * Recovery path: an already-claimed lease (takeover) becomes locally
     * owned, e.g. after runLiveTurnRecoveryTick resumed the turn here.
     */
    adoptRecoveredTurn(input) {
        this.registerActiveTurn(input.queueJid, {
            turnId: input.turn.id,
            runId: input.turn.runId ?? '',
            scope: {
                appId: input.turn.appId,
                agentSessionId: input.turn.agentSessionId,
                conversationId: input.turn.conversationId,
                threadId: input.turn.threadId,
            },
            fence: input.fence,
        });
    }
    registerActiveTurn(queueJid, input) {
        const registration = {
            turnId: input.turnId,
            runId: input.runId,
            scope: input.scope,
            fence: input.fence,
            hooks: null,
            fencedOut: false,
            pump: createLiveTurnCommandPump({
                liveTurns: this.deps.leaseDeps.liveTurns,
                turnId: input.turnId,
                fence: input.fence,
                canApplyCommand: (command) => command.commandType === 'interaction_resolved' ||
                    !!this.active.get(queueJid)?.hooks,
                handlers: {
                    continuation: (command) => this.applyContinuationCommand(queueJid, command.payload, command.seq),
                    stop: () => this.applyLocalHook(queueJid, 'applyStop'),
                    close_stdin: () => this.applyLocalHook(queueJid, 'applyCloseStdin'),
                    interaction_resolved: (command) => this.applyInteractionResolvedCommand(queueJid, command),
                },
                onError: (err, command) => this.warn({ err, queueJid, commandId: command.id, seq: command.seq }, 'Failed to apply live turn command'),
            }),
            tickTimer: setInterval(() => {
                void this.tick(queueJid);
            }, Math.max(250, this.deps.ownerPollMs ?? 1_000)),
        };
        registration.tickTimer.unref?.();
        this.active.set(queueJid, registration);
    }
    /**
     * The local runner is up: install the hooks the durable commands apply
     * to, and move the turn to 'running' (fenced).
     */
    async registerLocalRunner(queueJid, hooks, routing = {}) {
        const registration = this.active.get(queueJid);
        if (!registration)
            return;
        registration.hooks = hooks;
        if (routing.stopAliasJids !== undefined ||
            routing.requiredContinuationUserId !== undefined) {
            const routingUpdated = await this.deps.leaseDeps.liveTurns
                .updateLiveTurnRouting({
                id: registration.turnId,
                fence: registration.fence,
                stopAliasJids: routing.stopAliasJids,
                requiredContinuationUserId: routing.requiredContinuationUserId,
            })
                .catch((err) => {
                this.warn({ err, queueJid, turnId: registration.turnId }, 'Failed to update live turn routing metadata');
                return false;
            });
            if (!routingUpdated) {
                this.warn({ queueJid, turnId: registration.turnId }, 'Live turn routing metadata was not updated');
            }
        }
        const moved = await this.deps.leaseDeps.liveTurns
            .transitionLiveTurnStateFenced({
            id: registration.turnId,
            toState: 'running',
            fromStates: ['claimed', 'recovered'],
            fence: registration.fence,
        })
            .catch((err) => {
            this.warn({ err, queueJid, turnId: registration.turnId }, 'Failed to mark live turn running');
            return false;
        });
        if (!moved) {
            // Either already running (idempotent re-register) or fenced out; a
            // fenced-out owner stops applying commands on its next pump pass.
            this.warn({ queueJid, turnId: registration.turnId }, 'Live turn did not transition to running');
        }
        void this.drainQueue(queueJid);
    }
    async registerStopAliases(queueJid, stopAliasJids) {
        const registration = this.active.get(queueJid);
        if (!registration)
            return false;
        return this.deps.leaseDeps.liveTurns.updateLiveTurnRouting({
            id: registration.turnId,
            fence: registration.fence,
            stopAliasJids,
        });
    }
    /** Fenced state transition for the locally owned turn. */
    async transitionOwnedTurn(queueJid, toState, fromStates) {
        const registration = this.active.get(queueJid);
        if (!registration)
            return false;
        return this.deps.leaseDeps.liveTurns.transitionLiveTurnStateFenced({
            id: registration.turnId,
            toState,
            fromStates,
            fence: registration.fence,
        });
    }
    /**
     * Inbound follow-up message for an active scope. Returns true when the
     * message was durably queued to the owner (local or remote).
     */
    async routeMessage(input) {
        const result = await routeLiveContinuation({
            liveTurns: this.deps.leaseDeps.liveTurns,
            scope: input.scope,
            text: input.text,
            senderUserIds: input.senderUserIds,
            commandId: globalThis.crypto.randomUUID(),
            idempotencyKey: input.idempotencyKey,
            cursorAfter: input.cursorAfter,
            createdByWorkerId: this.deps.leaseDeps.workerInstanceId,
        });
        if (result.outcome === 'queued_to_owner') {
            void this.drainQueue(input.queueJid);
        }
        return result.outcome;
    }
    /** Inbound /stop (or alias). True when routed to an owner. */
    async routeStop(input) {
        const result = await routeLiveStop({
            liveTurns: this.deps.leaseDeps.liveTurns,
            scope: input.scope,
            aliasJid: input.aliasJid,
            commandId: globalThis.crypto.randomUUID(),
            idempotencyKey: input.idempotencyKey,
            requestedBy: input.requestedBy,
            createdByWorkerId: this.deps.leaseDeps.workerInstanceId,
        });
        if (result.outcome === 'queued_to_owner') {
            void this.drainQueue(input.queueJid);
            return true;
        }
        return false;
    }
    /** Inbound close-stdin signal. True when routed to an owner. */
    async routeCloseStdin(input) {
        const result = await routeLiveCloseStdin({
            liveTurns: this.deps.leaseDeps.liveTurns,
            scope: input.scope,
            aliasJid: input.aliasJid,
            commandId: globalThis.crypto.randomUUID(),
            idempotencyKey: input.idempotencyKey,
            createdByWorkerId: this.deps.leaseDeps.workerInstanceId,
        });
        if (result.outcome === 'queued_to_owner') {
            void this.drainQueue(input.queueJid);
            return true;
        }
        return false;
    }
    /**
     * Fenced terminal settlement for the locally owned turn; tears down the
     * local registration either way.
     */
    async finalize(queueJid, turnState, agentRunCompletion) {
        const registration = this.active.get(queueJid);
        if (!registration)
            return false;
        return this.settleRegistration(queueJid, registration, turnState, turnState === 'completed' ? 'completed' : 'failed', agentRunCompletion);
    }
    async settleRegistration(queueJid, registration, turnState, leaseOutcome, agentRunCompletion) {
        await this.drainInteractionResolutionCommands(queueJid, registration);
        const pending = await this.deps.leaseDeps.liveTurns.listPendingLiveTurnCommands({
            liveTurnId: registration.turnId,
            limit: 1,
        });
        if (pending.length > 0) {
            this.teardown(queueJid, registration);
            await this.deps.leaseDeps.coordination.settleRunLease({
                runId: registration.runId,
                leaseToken: registration.fence.leaseToken,
                workerInstanceId: registration.fence.workerInstanceId,
                fencingVersion: registration.fence.fencingVersion,
                outcome: 'released',
            });
            await this.deps.leaseDeps.coordination.releaseRunSlot({
                slotKey: liveTurnSlotKey(this.deps.leaseDeps.workerInstanceId),
                holderId: liveTurnSlotHolderId(registration.turnId, registration.fence.fencingVersion),
            });
            if (this.deps.hostSlotCapacity) {
                const holderId = hostExecutionSlotHolderId(liveTurnSlotHolderId(registration.turnId, registration.fence.fencingVersion));
                await this.deps.leaseDeps.coordination.releaseRunSlot({
                    slotKey: hostExecutionSlotKey(this.deps.leaseDeps.workerInstanceId, 'interactive'),
                    holderId,
                });
                await this.deps.leaseDeps.coordination.releaseRunSlot({
                    slotKey: hostExecutionSlotKey(this.deps.leaseDeps.workerInstanceId),
                    holderId,
                });
            }
            return false;
        }
        this.teardown(queueJid, registration);
        return finalizeLiveTurnExecution({
            deps: this.deps.leaseDeps,
            turnId: registration.turnId,
            fence: registration.fence,
            turnState,
            leaseOutcome,
            agentRunCompletion,
            hostSlotCapacity: this.deps.hostSlotCapacity?.(),
            hostBudgetCapacity: this.deps.hostBudgetCapacity?.(),
        });
    }
    async drainInteractionResolutionCommands(queueJid, registration) {
        for (;;) {
            const pending = await this.deps.leaseDeps.liveTurns.listPendingLiveTurnCommands({
                liveTurnId: registration.turnId,
                limit: 1,
            });
            const command = pending[0];
            if (!command || command.commandType !== 'interaction_resolved')
                return;
            const result = this.applyInteractionResolvedCommand(queueJid, command);
            if (result !== 'applied') {
                this.warn({ queueJid, turnId: registration.turnId, commandId: command.id }, 'Failed to apply interaction resolution during live turn finalization');
                return;
            }
            const marked = await this.deps.leaseDeps.liveTurns.markLiveTurnCommandApplied({
                id: command.id,
                appliedByWorkerId: registration.fence.workerInstanceId,
                fence: registration.fence,
            });
            if (!marked)
                return;
        }
    }
    async shutdown() {
        this.unsubscribeCommandWakeup?.();
        for (const [queueJid, registration] of [...this.active.entries()]) {
            await this.settleRegistration(queueJid, registration, 'failed', 'released', {
                status: 'failed',
                errorSummary: 'Live turn stopped during shutdown.',
            });
        }
    }
    teardown(queueJid, registration) {
        clearInterval(registration.tickTimer);
        this.active.delete(queueJid);
    }
    /**
     * One ownership tick: renew the lease + slot (and detect ownership loss),
     * then apply any pending durable commands locally. Runs at ownerPollMs
     * cadence — short enough that a reclaimed slot or fenced lease stops the
     * local runner promptly.
     */
    async tick(queueJid) {
        const registration = this.active.get(queueJid);
        if (!registration || registration.fencedOut)
            return;
        const owned = await this.heartbeat(queueJid);
        if (!owned)
            return;
        await this.drainQueue(queueJid);
    }
    /**
     * Renew lease + slot. Returns false (and tears the turn down) when this
     * worker has lost ownership — a fenced lease or a reclaimed slot — so the
     * local runner is stopped and durable state passes to the recovering
     * owner.
     */
    async heartbeat(queueJid) {
        const registration = this.active.get(queueJid);
        if (!registration || registration.fencedOut)
            return false;
        try {
            const result = await heartbeatLiveTurnLease({
                deps: this.deps.leaseDeps,
                turnId: registration.turnId,
                lease: {
                    runId: registration.runId,
                    leaseToken: registration.fence.leaseToken,
                    fencingVersion: registration.fence.fencingVersion,
                },
                leaseTtlMs: this.leaseTtlMs,
                hostSlotCapacity: this.deps.hostSlotCapacity?.(),
                hostBudgetCapacity: this.deps.hostBudgetCapacity?.(),
            });
            if (!result.leaseAlive || !result.slotHeld) {
                registration.fencedOut = true;
                this.warn({
                    queueJid,
                    turnId: registration.turnId,
                    leaseAlive: result.leaseAlive,
                    slotHeld: result.slotHeld,
                }, 'Live turn ownership lost; stopping local runner');
                registration.hooks?.applyStop();
                this.teardown(queueJid, registration);
                return false;
            }
            return true;
        }
        catch (err) {
            registration.fencedOut = true;
            this.warn({ err, queueJid, turnId: registration.turnId }, 'Live turn heartbeat failed; stopping local runner');
            registration.hooks?.applyStop();
            this.teardown(queueJid, registration);
            return false;
        }
    }
    /** Apply pending durable commands to the locally owned runner. */
    async drainQueue(queueJid) {
        const registration = this.active.get(queueJid);
        if (!registration || registration.fencedOut)
            return;
        if (!registration.hooks) {
            const pending = await this.deps.leaseDeps.liveTurns.listPendingLiveTurnCommands({
                liveTurnId: registration.turnId,
                limit: 1,
            });
            const first = pending[0];
            if (first && first.commandType !== 'interaction_resolved')
                return;
        }
        try {
            await registration.pump.drain();
        }
        catch (err) {
            this.warn({ err, queueJid, turnId: registration.turnId }, 'Live turn command drain failed');
        }
    }
    tickActiveQueues() {
        for (const queueJid of this.active.keys()) {
            void this.tick(queueJid);
        }
    }
    applyContinuationCommand(queueJid, payload, sequence) {
        const registration = this.active.get(queueJid);
        const hooks = registration?.hooks;
        if (!hooks)
            return 'retry';
        const text = typeof payload.text === 'string' ? payload.text : null;
        if (!text)
            return 'rejected';
        const threadId = typeof payload.threadId === 'string' ? payload.threadId : null;
        hooks.applyContinuation({ text, sequence, threadId });
        hooks.onContinuationApplied?.();
        return 'applied';
    }
    applyInteractionResolvedCommand(queueJid, command) {
        const handler = this.active.get(queueJid)?.hooks?.onInteractionResolved;
        const applied = handler
            ? handler(command.payload)
            : writeResolvedInteractionResponse(command.payload);
        return applied ? 'applied' : 'rejected';
    }
    applyLocalHook(queueJid, hook) {
        const registration = this.active.get(queueJid);
        const hooks = registration?.hooks;
        if (!hooks)
            return 'retry';
        hooks[hook]();
        return 'applied';
    }
}
