import type { LiveAdmissionWorkItem, LiveAdmissionClaimInput, LiveAdmissionWorkItemEnqueueResult, LiveTurn, LiveTurnAgentRunCompletion, LiveTurnCommandAppendInput, LiveTurnCommand, LiveTurnCommandNotifier, LiveTurnCoordinationRepository, LiveTurnLeaseFence, LiveTurnScope, LiveTurnState } from '../../../../domain/ports/live-turns.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
type EnqueueLiveAdmissionWorkItemInput = Parameters<LiveTurnCoordinationRepository['enqueueLiveAdmissionWorkItem']>[0];
type RenewLiveAdmissionWorkItemClaimInput = Parameters<LiveTurnCoordinationRepository['renewLiveAdmissionWorkItemClaim']>[0];
export declare class PostgresLiveTurnRepository implements LiveTurnCoordinationRepository {
    private readonly db;
    private readonly commandNotifier?;
    private readonly maxLiveAdmissionBacklog;
    constructor(db: CanonicalDb, commandNotifier?: LiveTurnCommandNotifier | undefined, maxLiveAdmissionBacklog?: number);
    enqueueLiveAdmissionWorkItem(input: EnqueueLiveAdmissionWorkItemInput): Promise<LiveAdmissionWorkItemEnqueueResult>;
    claimLiveAdmissionWorkItems(input: LiveAdmissionClaimInput): Promise<LiveAdmissionWorkItem[]>;
    renewLiveAdmissionWorkItemClaim(input: RenewLiveAdmissionWorkItemClaimInput): Promise<boolean>;
    deferLiveAdmissionWorkItem(input: {
        id: string;
        claimToken: string;
        workerInstanceId: string;
        reason: 'queued_capacity' | 'listener_degraded' | 'retry';
        deferUntil: string;
        countFailure?: boolean;
        now?: string;
    }): Promise<boolean>;
    settleLiveAdmissionWorkItem(input: {
        id: string;
        claimToken: string;
        workerInstanceId: string;
        state: Extract<LiveAdmissionWorkItem['state'], 'completed' | 'failed' | 'canceled'>;
        now?: string;
    }): Promise<boolean>;
    claimLiveTurn(input: {
        id: string;
        scope: LiveTurnScope;
        workerInstanceId: string;
        runId?: string | null;
        pendingMessage?: Record<string, unknown> | null;
        stopAliasJids?: string[];
        requiredContinuationUserId?: string | null;
        now?: string;
    }): Promise<LiveTurn | null>;
    getActiveLiveTurn(input: {
        scope: LiveTurnScope;
    }): Promise<LiveTurn | null>;
    getLiveTurnById(id: string): Promise<LiveTurn | null>;
    findActiveLiveTurnByStopAlias(input: {
        aliasJid: string;
    }): Promise<LiveTurn | null>;
    findActiveLiveTurnByRunId(input: {
        runId: string;
    }): Promise<LiveTurn | null>;
    transitionLiveTurnState(input: {
        id: string;
        toState: LiveTurnState;
        fromStates: LiveTurnState[];
        agentRunCompletion?: LiveTurnAgentRunCompletion | null;
        now?: string;
    }): Promise<boolean>;
    attachLiveTurnLease(input: {
        id: string;
        runId: string;
        lease: LiveTurnLeaseFence;
        now?: string;
    }): Promise<boolean>;
    updateLiveTurnRouting(input: {
        id: string;
        fence: LiveTurnLeaseFence;
        stopAliasJids?: string[];
        requiredContinuationUserId?: string | null;
        now?: string;
    }): Promise<boolean>;
    transitionLiveTurnStateFenced(input: {
        id: string;
        toState: LiveTurnState;
        fromStates: LiveTurnState[];
        fence: LiveTurnLeaseFence;
        now?: string;
    }): Promise<boolean>;
    finalizeLiveTurnWithLease(input: {
        id: string;
        turnState: Extract<LiveTurnState, 'completed' | 'failed' | 'timed_out'>;
        leaseOutcome: 'completed' | 'failed' | 'released';
        fence: LiveTurnLeaseFence;
        agentRunCompletion?: LiveTurnAgentRunCompletion | null;
        requireNoPendingCommands?: boolean;
        now?: string;
    }): Promise<boolean>;
    takeOverLiveTurn(input: {
        id: string;
        lease: LiveTurnLeaseFence;
        now?: string;
    }): Promise<boolean>;
    listRecoverableLiveTurns(input: {
        unleasedStaleBefore: string;
        limit: number;
        now?: string;
    }): Promise<LiveTurn[]>;
    getOldestWaitingLiveAdmission(input: {
        conversationJids: string[];
        now?: string;
    }): Promise<{
        conversationJid: string;
        threadId: string | null;
        waitingSince: string;
        ageSeconds: number;
    } | null>;
    appendLiveTurnCommand(input: LiveTurnCommandAppendInput): Promise<import("../../../../domain/ports/live-turns.js").LiveTurnCommandAppendResult>;
    listPendingLiveTurnCommands(input: {
        liveTurnId: string;
        limit: number;
    }): Promise<LiveTurnCommand[]>;
    isLiveTurnCommandFenceActive(input: {
        id: string;
        fence: LiveTurnLeaseFence;
        now?: string;
    }): Promise<boolean>;
    markLiveTurnCommandApplied(input: {
        id: string;
        appliedByWorkerId: string;
        fence?: LiveTurnLeaseFence;
        now?: string;
    }): Promise<boolean>;
    markLiveTurnCommandRejected(input: {
        id: string;
        reason: string;
        fence?: LiveTurnLeaseFence;
        now?: string;
    }): Promise<boolean>;
}
export {};
