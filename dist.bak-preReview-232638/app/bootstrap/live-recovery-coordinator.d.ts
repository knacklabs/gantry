import type { RuntimeLease } from '../../domain/ports/runtime-lease.js';
import type { LiveTurnScope } from '../../domain/ports/live-turns.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import type { NewMessage } from '../../domain/types.js';
/**
 * WP2: the singleton lease is now a RECOVERY COORDINATOR election, not a live
 * host election. Live-turn admission runs on every live worker (distributed);
 * only startup pending-message recovery and the periodic recovery sweep are
 * gated by this lease so they run on exactly one worker.
 */
export declare const LIVE_RECOVERY_COORDINATOR_LEASE_KEY = "runtime:live-recovery-coordinator:default";
/** Bounded exponential backoff for the standby acquirer loop. */
export declare const LIVE_RECOVERY_COORDINATOR_LEASE_BASE_BACKOFF_MS = 1000;
export declare const LIVE_RECOVERY_COORDINATOR_LEASE_MAX_BACKOFF_MS = 30000;
export interface LiveRecoveryCoordinatorLeasePort {
    tryAcquire: (key: string) => Promise<RuntimeLease | undefined>;
}
interface LiveTurnRuntimeSettings {
    runtime: {
        liveTurns: {
            enabled: boolean;
        };
    };
}
export interface LiveRecoveryCoordinatorTransitionHandlers {
    /** Fired each time this worker acquires the coordinator lease (boot or takeover). */
    onAcquired: (lease: RuntimeLease) => void;
    /** Fired when a held lease is lost; the manager re-enters standby acquisition. */
    onLost: (err: Error) => void;
}
export interface LiveRecoveryCoordinatorLeaseManager {
    /** Resolves on the FIRST acquisition, or undefined when live turns are disabled. */
    whenAcquired: () => Promise<RuntimeLease | undefined>;
    /** The current lease if this worker is the recovery coordinator, otherwise undefined. */
    getLease: () => RuntimeLease | undefined;
    /**
     * Register the single transition consumer that starts/stops the recovery
     * coordinator services. If the lease is already held at registration,
     * onAcquired fires immediately (replay), so registration order does not race
     * acquisition.
     */
    onTransition: (handlers: LiveRecoveryCoordinatorTransitionHandlers) => void;
    /** Stop the standby acquirer and release the lease if held (drain handoff). */
    stop: () => Promise<void>;
}
interface AcquisitionLogger {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
}
interface StartLiveRecoveryCoordinatorLeaseAcquisitionDeps {
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
    random?: () => number;
    logger?: AcquisitionLogger;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
}
/**
 * Acquire the singleton live-recovery-coordinator lease without blocking the
 * rest of startup. WP2: every live worker polls and admits turns; this lease
 * elects only the single worker that runs recovery (startup pending-message
 * recovery + the periodic recovery sweep). A worker that loses the race boots
 * fine and keeps retrying; when the holder drains and releases, a standby
 * acquirer takes over. Acquisition never throws and never blocks; callers await
 * {@link LiveRecoveryCoordinatorLeaseManager.whenAcquired} only where they
 * actually need to be the coordinator.
 */
export declare function startLiveRecoveryCoordinatorLeaseAcquisition(input: {
    runtimeSettings: LiveTurnRuntimeSettings;
    leases: LiveRecoveryCoordinatorLeasePort;
    /**
     * Whether this process role runs live execution. Defaults to true so
     * single-host embeddings/tests are unchanged. A role without live execution
     * (control, job-worker) never acquires the coordinator lease.
     */
    liveExecutionEnabled?: boolean;
    deps?: StartLiveRecoveryCoordinatorLeaseAcquisitionDeps;
}): LiveRecoveryCoordinatorLeaseManager;
export interface LiveTurnScopeRepository {
    getAgentTurnContext?: (input: {
        agentFolder: string;
        executionProviderId: ExecutionProviderId;
        conversationJid: string;
        threadId: string | null;
        providerAccountId?: string | null;
        conversationKind?: 'channel' | 'dm';
        hydrateMemory: boolean;
    }) => Promise<{
        appId: string;
        agentSessionId: string;
    } | undefined>;
}
interface LiveTurnScopeApp {
    getConversationRoutes(): Record<string, {
        folder: string;
        conversationKind?: 'channel' | 'dm';
        agentConfig?: {
            model?: string;
        };
    }>;
    resolveExecutionProviderId?: (route: {
        folder: string;
        conversationKind?: 'channel' | 'dm';
        agentConfig?: {
            model?: string;
        };
    }, chatJid: string) => Promise<ExecutionProviderId> | ExecutionProviderId;
}
export declare function liveTurnScopeForQueue(input: {
    app: LiveTurnScopeApp;
    opsRepository: LiveTurnScopeRepository;
    executionAdapter: {
        id: ExecutionProviderId;
    };
    queueJid: string;
}): Promise<LiveTurnScope | null>;
export declare function routeScopeActiveLiveTurnAdmission(input: {
    scope: LiveTurnScope;
    queueJid: string;
    liveRunId: string;
    continuation?: {
        text: string;
        senderUserIds: readonly string[];
        idempotencyKey: string;
        cursorAfter?: string | null;
        onRouted: () => Promise<void> | void;
    } | null;
    routeMessage?: (input: {
        scope: LiveTurnScope;
        queueJid: string;
        text: string;
        senderUserIds?: readonly string[] | null;
        idempotencyKey: string;
        cursorAfter?: string | null;
    }) => Promise<'queued_to_owner' | 'no_active_turn' | 'sender_not_allowed'>;
    completeSessionAgentRun?: (input: {
        runId: string;
        status: 'canceled' | 'failed';
        errorSummary: string;
    }) => Promise<unknown>;
}): Promise<boolean>;
export declare function routeScopeActiveLiveTurnAdmissionFromCursor(input: {
    scope: LiveTurnScope;
    queueJid: string;
    liveRunId: string;
    chatJid: string;
    threadId: string | null;
    replayCursor: string;
    messageFetchPageSize: number;
    timezone: string;
    getMessagesSince?: (conversationJid: string, sinceCursor: string, limit?: number, options?: {
        threadId?: string | null;
        providerAccountId?: string | null;
    }) => Promise<NewMessage[]>;
    setAgentCursor: (queueJid: string, cursor: string) => void;
    saveState: () => Promise<void> | void;
    enqueueMessageCheck?: (queueJid: string) => void;
    isActiveControlMessage?: (message: NewMessage) => boolean;
    handleActiveControlMessage?: (message: NewMessage) => Promise<boolean>;
    routeMessage: NonNullable<Parameters<typeof routeScopeActiveLiveTurnAdmission>[0]['routeMessage']>;
    completeSessionAgentRun?: Parameters<typeof routeScopeActiveLiveTurnAdmission>[0]['completeSessionAgentRun'];
}): Promise<boolean>;
export {};
