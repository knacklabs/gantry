import type { LiveTurn, LiveTurnAgentRunCompletion, LiveTurnCommandWakeupSource, LiveTurnLeaseFence, LiveTurnScope } from '../domain/ports/live-turns.js';
import { type LiveTurnLeaseDeps } from '../application/live-turns/live-turn-lease-service.js';
/**
 * Per-worker live-turn authority: the durable replacement for GroupQueue's
 * process-local active state. Admission claims a durable turn + lease +
 * slot; inbound traffic routes through the durable owner inbox; the local
 * registry only mirrors which turns THIS worker owns so commands can be
 * applied to the local runner without polling delay.
 */
type WarnLog = (context: Record<string, unknown>, message: string) => void;
export interface LiveTurnLocalRunnerHooks {
    /** Write the continuation into the local runner's IPC input. */
    applyContinuation: (input: {
        text: string;
        sequence: number;
        threadId: string | null;
    }) => void;
    /** Close the local runner's stdin (end of turn input). */
    applyCloseStdin: () => void;
    /** Stop the local runner (SIGTERM path). */
    applyStop: () => void;
    /** A continuation was delivered; restart user-visible turn UI. */
    onContinuationApplied?: () => void;
    /** A durable interaction resolution arrived for this turn. */
    onInteractionResolved?: (payload: Record<string, unknown>) => boolean;
}
export type LiveTurnAdmission = {
    outcome: 'claimed';
    turn: LiveTurn;
    fence: LiveTurnLeaseFence;
} | {
    outcome: 'scope_active';
} | {
    outcome: 'no_capacity';
} | {
    outcome: 'lease_unavailable';
};
export declare class LiveTurnAuthority {
    private readonly deps;
    private readonly active;
    private readonly unsubscribeCommandWakeup?;
    private draining;
    constructor(deps: {
        leaseDeps: LiveTurnLeaseDeps;
        slotCapacity: () => number;
        hostSlotCapacity?: () => number;
        hostBudgetCapacity?: () => number;
        leaseTtlMs?: number;
        ownerPollMs?: number;
        commandWakeupSource?: LiveTurnCommandWakeupSource;
        warn?: WarnLog;
    });
    /**
     * Stop admitting new live turns during graceful drain. Already-active turns
     * keep running to completion; only fresh admissions are rejected so the run
     * is recovered by the successor live host.
     */
    beginDraining(): void;
    private get leaseTtlMs();
    private warn;
    /**
     * Cheap durable pre-check used before minting an agent run row: with N
     * pollers, the common case is that another worker already owns the scope, so
     * the caller can route a continuation instead of creating an orphan run.
     */
    getActiveLiveTurn(scope: LiveTurnScope): Promise<LiveTurn | null>;
    /** Whether this worker currently owns the live turn for `queueJid`. */
    ownsQueue(queueJid: string): boolean;
    ownedRunId(queueJid: string): string | null;
    ownedFence(queueJid: string): LiveTurnLeaseFence | null;
    /**
     * Admission for a new live message turn. On 'claimed', the caller starts
     * the runner and must call registerLocalRunner + finalize. On
     * 'scope_active', the message must be routed as a continuation instead.
     */
    admit(input: {
        queueJid: string;
        scope: LiveTurnScope;
        turnId: string;
        runId: string;
        pendingMessage?: Record<string, unknown> | null;
        stopAliasJids?: string[];
        requiredContinuationUserId?: string | null;
    }): Promise<LiveTurnAdmission>;
    /**
     * Recovery path: an already-claimed lease (takeover) becomes locally
     * owned, e.g. after runLiveTurnRecoveryTick resumed the turn here.
     */
    adoptRecoveredTurn(input: {
        queueJid: string;
        turn: LiveTurn;
        fence: LiveTurnLeaseFence;
    }): void;
    private registerActiveTurn;
    /**
     * The local runner is up: install the hooks the durable commands apply
     * to, and move the turn to 'running' (fenced).
     */
    registerLocalRunner(queueJid: string, hooks: LiveTurnLocalRunnerHooks, routing?: {
        stopAliasJids?: string[];
        requiredContinuationUserId?: string | null;
    }): Promise<void>;
    registerStopAliases(queueJid: string, stopAliasJids: string[]): Promise<boolean>;
    /** Fenced state transition for the locally owned turn. */
    transitionOwnedTurn(queueJid: string, toState: 'running' | 'awaiting_interaction' | 'setup_required', fromStates: Array<'claimed' | 'running' | 'awaiting_interaction' | 'setup_required' | 'recovered'>): Promise<boolean>;
    /**
     * Inbound follow-up message for an active scope. Returns true when the
     * message was durably queued to the owner (local or remote).
     */
    routeMessage(input: {
        scope: LiveTurnScope;
        queueJid: string;
        text: string;
        senderUserIds?: readonly string[] | null;
        idempotencyKey: string;
        cursorAfter?: string | null;
    }): Promise<'queued_to_owner' | 'no_active_turn' | 'sender_not_allowed'>;
    /** Inbound /stop (or alias). True when routed to an owner. */
    routeStop(input: {
        scope?: LiveTurnScope;
        aliasJid?: string;
        queueJid: string;
        idempotencyKey: string;
        requestedBy?: string | null;
    }): Promise<boolean>;
    /** Inbound close-stdin signal. True when routed to an owner. */
    routeCloseStdin(input: {
        scope?: LiveTurnScope;
        aliasJid?: string;
        queueJid: string;
        idempotencyKey: string;
    }): Promise<boolean>;
    /**
     * Fenced terminal settlement for the locally owned turn; tears down the
     * local registration either way.
     */
    finalize(queueJid: string, turnState: 'completed' | 'failed' | 'timed_out', agentRunCompletion?: LiveTurnAgentRunCompletion | null): Promise<boolean>;
    private settleRegistration;
    private drainInteractionResolutionCommands;
    shutdown(): Promise<void>;
    private teardown;
    /**
     * One ownership tick: renew the lease + slot (and detect ownership loss),
     * then apply any pending durable commands locally. Runs at ownerPollMs
     * cadence — short enough that a reclaimed slot or fenced lease stops the
     * local runner promptly.
     */
    private tick;
    /**
     * Renew lease + slot. Returns false (and tears the turn down) when this
     * worker has lost ownership — a fenced lease or a reclaimed slot — so the
     * local runner is stopped and durable state passes to the recovering
     * owner.
     */
    private heartbeat;
    /** Apply pending durable commands to the locally owned runner. */
    drainQueue(queueJid: string): Promise<void>;
    private tickActiveQueues;
    private applyContinuationCommand;
    private applyInteractionResolvedCommand;
    private applyLocalHook;
}
export {};
