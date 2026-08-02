import type { LiveAdmissionWakeupSource, LiveTurn } from '../../domain/ports/live-turns.js';
import type { AgentTodoCardStatus, AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
import type { GroupMessageRunContext } from '../../runtime/group-queue-types.js';
import type { GroupProcessOptions } from '../../runtime/group-processing-types.js';
import type { RuntimeLease } from '../../domain/ports/runtime-lease.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import type { ConversationRoute, NewMessage } from '../../domain/types.js';
import type { ProcessRole } from './roles/process-role.js';
import type { LiveTurnAuthority } from '../../runtime/live-turn-authority.js';
import type { LiveTurnLeaseDeps } from '../../application/live-turns/live-turn-lease-service.js';
import { type LiveTurnRecoveryLoop } from '../../runtime/live-turn-recovery.js';
import { recoverPendingMessages as defaultRecoverPendingMessages, type MessageLoopDeps } from '../../runtime/message-loop.js';
import { startLiveAdmissionWorkLoop as defaultStartLiveAdmissionWorkLoop, type LiveAdmissionWorkLoopHandle } from '../../runtime/live-admission-work-loop.js';
import { type LiveTurnBrowserFinalizer } from './live-turn-browser-finalizer.js';
import { type SessionCommand } from '../../session/session-commands.js';
type WarnLog = (context: Record<string, unknown>, message: string) => void;
type InfoLog = (obj: string | Record<string, unknown>, msg?: string) => void;
export type ActiveControlRoute = {
    folder: string;
    trigger?: string;
    conversationKind?: 'dm' | 'channel';
    providerAccountId?: string;
    agentConfig?: {
        model?: string;
    };
};
export type ActiveControlCommandHandler = (args: {
    chatJid: string;
    queueJid: string;
    group: ActiveControlRoute;
    message: NewMessage;
    command: SessionCommand;
}) => Promise<boolean> | boolean;
interface AdmissionOpsRepository {
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
        providerSessionId?: string | null;
    } | undefined>;
    createSessionAgentRun?: (input: {
        agentSessionId: string;
        executionProviderId: ExecutionProviderId;
        providerSessionId?: string | null;
        cause: 'message';
    }) => Promise<string | undefined>;
    completeSessionAgentRun?: (input: {
        runId: string;
        status: 'completed' | 'failed' | 'canceled';
        resultSummary?: string | null;
        errorSummary?: string | null;
    }) => Promise<unknown>;
    getMessagesSince?: (conversationJid: string, sinceCursor: string, limit?: number, options?: {
        threadId?: string | null;
        providerAccountId?: string | null;
    }) => Promise<NewMessage[]>;
}
interface AdmissionApp {
    getConversationRoutes(): Record<string, ConversationRoute>;
    resolveExecutionProviderId?: (route: ConversationRoute, chatJid: string) => Promise<ExecutionProviderId> | ExecutionProviderId;
    processGroupMessages: (queueJid: string, options: GroupProcessOptions & {
        queued: boolean;
    }) => Promise<boolean>;
    getOrRecoverCursor: (queueJid: string) => Promise<string>;
    setAgentCursor: (queueJid: string, cursor: string) => void;
    saveState: () => Promise<void> | void;
}
export declare function buildLiveAdmissionProcessor(input: {
    liveTurnAuthority: LiveTurnAuthority | undefined;
    app: AdmissionApp;
    opsRepository: AdmissionOpsRepository;
    executionAdapter: {
        id: ExecutionProviderId;
    };
    messageFetchPageSize: number;
    timezone: string;
    enqueueMessageCheck: (queueJid: string) => void;
    warn: WarnLog;
    addReaction?: (jid: string, messageRef: string, emoji: string, options?: {
        providerAccountId?: string;
    }) => Promise<void>;
    finalizeAgentTodo?: (jid: string, input: {
        threadId?: string | null;
        cardKind?: AgentTodoRender['cardKind'];
        status: AgentTodoCardStatus;
    }, options?: {
        providerAccountId?: string;
    }) => Promise<boolean>;
    finalizeBrowserForLiveTurn?: LiveTurnBrowserFinalizer;
    handleActiveControlCommand?: ActiveControlCommandHandler;
}): (queueJid: string, context?: GroupMessageRunContext) => Promise<boolean>;
export interface LiveExecutionServicesHandle {
    /** Stop the always-on admission loop (drain/handoff). */
    stopAdmission: () => void;
    /** Stop the recovery coordinator loop if this worker held it. */
    stopRecovery: () => void;
    /** Current admission loop handle (registered as the active loop for shutdown). */
    admissionLoop: LiveAdmissionWorkLoopHandle | undefined;
    /** Current recovery loop handle, set only while this worker is coordinator. */
    recoveryLoop: LiveTurnRecoveryLoop | undefined;
}
export interface WaitingStatusCoordination {
    /** Start the monitor; returns a handle with stop + oldest-age accessor. */
    start: () => {
        stop: () => void;
        oldestWaitingSeconds: () => number;
    };
    /** Register the active monitor (or undefined when stopped) for /metrics + shutdown. */
    register: (handle: {
        oldestWaitingSeconds: () => number;
    } | undefined) => void;
}
/**
 * Start the live execution services for a live-capable worker.
 *
 * WP2 split:
 *  - The admission loop runs UNCONDITIONALLY on every live worker. When the
 *    live-turn repository exposes durable admission claims, it processes
 *    queue-scoped work items instead of scanning every route. It is NOT gated
 *    by any recovery lease.
 *  - The recovery COORDINATOR — startup `recoverPendingMessages` plus the
 *    periodic recovery sweep — is the only lease-gated piece. Exactly one worker
 *    holds the `runtime:live-recovery-coordinator:default` advisory lease and
 *    runs recovery; recovered turns resume ON THE COORDINATOR under a strictly
 *    higher fencing version. If the coordinator lacks slot capacity for a turn,
 *    `runLiveTurnRecoveryTick` defers that turn (capacityExhausted) to the next
 *    tick rather than crash-looping.
 */
export declare function startLiveExecutionServices(input: {
    appId: string;
    processRole?: ProcessRole;
    app: AdmissionApp & {
        queue: {
            getPolicy: () => {
                maxMessageRuns: number;
                maxRetries?: number;
            };
            enqueueMessageCheck: (queueJid: string) => void | boolean;
        };
    };
    liveTurnAuthority: LiveTurnAuthority | undefined;
    liveTurnLeaseDeps: LiveTurnLeaseDeps | undefined;
    messageLoopDeps: MessageLoopDeps;
    recoveryCoordinator: RecoveryCoordinatorPort | undefined;
    isEligibleToRecoverLiveTurn: (turn: LiveTurn) => boolean | Promise<boolean>;
    alertNoEligibleLiveTurnRecoverer: ((turn: LiveTurn) => Promise<void> | void) | undefined;
    recoverPendingMessages?: typeof defaultRecoverPendingMessages;
    startLiveAdmissionWorkLoop?: typeof defaultStartLiveAdmissionWorkLoop;
    liveAdmissionWakeupSource?: LiveAdmissionWakeupSource;
    registerActiveAdmissionLoop: (loop: LiveAdmissionWorkLoopHandle | undefined) => void;
    registerActiveRecoveryLoop: (loop: LiveTurnRecoveryLoop | undefined) => void;
    /** Waiting-status monitor, started/stopped with the coordinator. */
    waitingStatus?: WaitingStatusCoordination;
    onPollingCrash: (err: unknown) => void;
    info: InfoLog;
    warn: WarnLog;
    addReaction?: (jid: string, messageRef: string, emoji: string, options?: {
        providerAccountId?: string;
    }) => Promise<void>;
}): LiveExecutionServicesHandle;
export interface RecoveryCoordinatorPort {
    onTransition: (handlers: {
        onAcquired: (lease: RuntimeLease) => void;
        onLost: (err: Error) => void;
    }) => void;
}
export {};
