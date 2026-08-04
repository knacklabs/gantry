import type { Pool } from 'pg';
import type { ChatInfo, Job, JobEvent, JobRun, NewMessage, ConversationRoute } from '../../../../domain/repositories/domain-types.js';
import type { AgentSession, ExecutionProviderId } from '../../../../domain/sessions/sessions.js';
import type { RunLease } from '../../../../domain/ports/worker-coordination.js';
import type { LiveAdmissionWorkItemEnqueueResult, LiveAdmissionWorkItemNotifier } from '../../../../domain/ports/live-turns.js';
import type { JobEventListFilters, JobListFilters, JobRunListFilters, JobUpsertInput, ReleasedStaleJobLease, RuntimeAgentSessionRepository, RuntimeChatMetadataRepository, RuntimeConversationRouteRepository, RuntimeJobRepository, RuntimeMessageRepository, RuntimeRouterStateRepository } from '../../../../domain/repositories/ops-repo.js';
import type { RuntimeEventPublishInput } from '../../../../domain/events/events.js';
import { type CanonicalDb } from '../repositories/canonical-graph-repository.postgres.js';
interface SessionRuntimeOptions {
    memoryItemLimit?: number;
    maxMemoryContextChars?: number;
    loadAppMemoryItems?: (input: {
        session: AgentSession;
        limit: number;
        conversationKind?: string;
        query?: string;
    }) => Promise<Array<{
        id: string;
        kind: string;
        key: string;
        value: string;
        subject: Record<string, unknown>;
    }>>;
}
interface RuntimeEventPublisher {
    publish(input: RuntimeEventPublishInput): Promise<unknown>;
}
export declare class PostgresRuntimeRepositoryBundle implements RuntimeChatMetadataRepository, RuntimeMessageRepository, RuntimeJobRepository, RuntimeRouterStateRepository, RuntimeAgentSessionRepository, RuntimeConversationRouteRepository {
    private readonly pool;
    private readonly db;
    private readonly options;
    private readonly graph;
    private readonly messages;
    private readonly jobs;
    private readonly sessions;
    private readonly bindings;
    private readonly routerState;
    constructor(pool: Pool, db: CanonicalDb, options: {
        runtimeEvents: RuntimeEventPublisher;
        sessions?: SessionRuntimeOptions;
        liveAdmissionNotifier?: LiveAdmissionWorkItemNotifier;
        maxLiveAdmissionBacklog?: number;
    });
    close(): Promise<void>;
    storeChatMetadata(chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean, options?: {
        providerAccountId?: string | null;
    }): Promise<void>;
    getAllChats(): Promise<ChatInfo[]>;
    storeMessage(msg: NewMessage): Promise<void>;
    storeMessageWithLiveAdmission(msg: NewMessage, admission: {
        appId: string;
        agentId?: string | null;
        agentSessionId?: string | null;
        triggerDecision?: Record<string, unknown>;
        now?: string;
    }): Promise<LiveAdmissionWorkItemEnqueueResult | undefined>;
    notifyLiveAdmissionWorkItem(result: LiveAdmissionWorkItemEnqueueResult): Promise<void>;
    getMessagesSince(chatJid: string, sinceCursor: string, limit?: number, options?: {
        threadId?: string | null;
        providerAccountId?: string | null;
    }): Promise<NewMessage[]>;
    getContextMessagesSince(chatJid: string, sinceCursor: string, limit?: number, options?: {
        threadId?: string | null;
        providerAccountId?: string | null;
    }): Promise<NewMessage[]>;
    getRecentTopLevelMessagesBefore(chatJid: string, before: Pick<NewMessage, 'timestamp' | 'id'>, limit?: number, options?: {
        providerAccountId?: string | null;
    }): Promise<NewMessage[]>;
    getFirstThreadMessages(chatJid: string, threadId: string, limit?: number, options?: {
        providerAccountId?: string | null;
    }): Promise<NewMessage[]>;
    getLatestThreadMessages(chatJid: string, threadId: string, beforeOrAt: Pick<NewMessage, 'timestamp' | 'id'>, limit?: number, options?: {
        providerAccountId?: string | null;
    }): Promise<NewMessage[]>;
    getMessageThreadIds(chatJid: string, options?: {
        providerAccountId?: string | null;
    }): Promise<Array<string | null>>;
    getLastBotMessageCursor(chatJid: string, options?: {
        providerAccountId?: string | null;
    }): Promise<{
        timestamp: string;
        id: string;
    } | undefined>;
    getLastBotMessageTimestamp(chatJid: string, options?: {
        providerAccountId?: string | null;
    }): Promise<string | undefined>;
    upsertJob(job: JobUpsertInput): Promise<{
        created: boolean;
    }>;
    getJobById(id: string): Promise<Job | undefined>;
    getAllJobs(): Promise<Job[]>;
    listJobs(filters?: JobListFilters): Promise<Job[]>;
    getRecentJobRuns(limit?: number): Promise<JobRun[]>;
    updateJob(id: string, updates: Partial<Job>): Promise<void>;
    deleteJob(id: string): Promise<void>;
    deleteExpiredCompletedOneTimeJobs(nowIso?: string): Promise<number>;
    claimDueJobRunStart(input: {
        jobId: string;
        runId: string;
        executionProviderId: ExecutionProviderId;
        workerId?: string | null;
        leaseOwner?: string | null;
        workerInstanceId: string;
        scheduledFor: string;
        startedAt: string;
        retryCount: number;
        leaseExpiresAt: string;
        requireNextRun?: boolean;
    }): Promise<RunLease | null>;
    settleJobRunLease(input: {
        runId: string;
        leaseToken: string;
        outcome: 'completed' | 'failed' | 'released';
        allowAlreadySettled?: boolean;
    }): Promise<boolean>;
    releaseStaleJobLeases(nowIso?: string): Promise<ReleasedStaleJobLease[]>;
    createJobRun(run: JobRun): Promise<boolean>;
    completeJobRun(runId: string, status: JobRun['status'], resultSummary?: string | null, errorSummary?: string | null): Promise<void>;
    completeJobRunWithLease(input: {
        runId: string;
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
        status: JobRun['status'];
        resultSummary?: string | null;
        errorSummary?: string | null;
    }): Promise<boolean>;
    finalizeJobRunLease(input: {
        runId: string;
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
        leaseOutcome: 'completed' | 'failed' | 'released';
        runStatus: JobRun['status'];
        resultSummary?: string | null;
        errorSummary?: string | null;
    }): Promise<boolean>;
    finalizeJobRunWithLease(input: {
        jobId: string;
        runId: string;
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
        leaseOutcome: 'completed' | 'failed' | 'released';
        runStatus: JobRun['status'];
        resultSummary?: string | null;
        errorSummary?: string | null;
        jobUpdates: Partial<Job>;
    }): Promise<boolean>;
    markJobRunNotified(runId: string, lease?: {
        leaseToken: string;
        workerInstanceId: string;
        fencingVersion: number;
    }): Promise<boolean>;
    getJobRunById(runId: string): Promise<JobRun | undefined>;
    listJobRuns(jobId?: string, limit?: number, filters?: JobRunListFilters): Promise<JobRun[]>;
    listLatestJobRunsByJobIds(jobIds: readonly string[]): Promise<Map<string, JobRun>>;
    listDeadLetterRuns(limit?: number): Promise<JobRun[]>;
    listRecentJobEvents(limit?: number, filters?: JobEventListFilters): Promise<JobEvent[]>;
    getRouterState(key: string): Promise<string | undefined>;
    setRouterState(key: string, value: string): Promise<void>;
    setSession(agentFolder: string, sessionId: string, threadId: string | null | undefined, metadata: {
        appId?: string;
        executionProviderId: ExecutionProviderId;
        conversationJid?: string;
        providerAccountId?: string | null;
        conversationKind?: 'dm' | 'channel';
        memoryUserId?: string;
        expectedAgentSessionId?: string;
        expectedAgentSessionResetAt?: string | null;
        accessFingerprint?: string;
    }): Promise<boolean>;
    getAgentTurnContext(input: {
        appId?: string;
        agentFolder: string;
        executionProviderId: ExecutionProviderId;
        conversationJid: string;
        providerAccountId?: string | null;
        threadId?: string | null;
        conversationKind?: 'dm' | 'channel';
        memoryUserId?: string;
        jobId?: string;
        query?: string;
        hydrateMemory?: boolean;
        hydrationMode?: 'first_visible' | 'full';
        promoteReadyProviderSession?: boolean;
    }): Promise<{
        appId: string;
        agentId: string;
        agentSessionId: string;
        agentSessionResetAt?: string | null;
        providerSessionId?: string;
        externalSessionId?: string;
        latestProviderSessionLocked?: boolean;
        lockedProviderSessionId?: string;
        latestProviderSessionReady?: boolean;
        readyProviderSessionId?: string;
        readyExternalSessionId?: string;
        providerSessionAccessFingerprint?: string;
        compactionDeltaReplay?: {
            status: 'pending' | 'applied' | 'degraded';
            baseCursor?: string;
            lockedAt?: string;
        };
        memoryContextBlock?: string;
    }>;
    expireProviderSession(input: {
        providerSessionId: string;
        agentSessionId: string;
        provider: string;
        externalSessionId: string;
    }): Promise<void>;
    markProviderSessionMaintenance(input: {
        providerSessionId: string;
        agentSessionId: string;
        provider: string;
        externalSessionId: string;
        compactionBaseCursor?: string | null;
    }): Promise<boolean>;
    markProviderSessionDeltaReplay(input: {
        providerSessionId: string;
        agentSessionId: string;
        provider: string;
        externalSessionId: string;
        status: 'applied' | 'degraded';
        reason?: string;
    }): Promise<void>;
    finishProviderSessionMaintenance(input: {
        providerSessionId: string;
        agentSessionId: string;
        provider: string;
        externalSessionId: string;
        status: 'active' | 'expired' | 'ready';
    }): Promise<void>;
    createSessionAgentRun(input: {
        agentSessionId: string;
        executionProviderId: ExecutionProviderId;
        providerSessionId?: string | null;
        cause: 'message' | 'job' | 'control' | 'manual';
    }): Promise<string | undefined>;
    updateAgentRunProviderMetadata(input: {
        runId: string;
        runIds?: string[];
        fenceRunId?: string;
        leaseToken?: string;
        workerInstanceId?: string;
        fencingVersion?: number;
        providerRunId?: string | null;
        providerSessionId?: string | null;
    }): Promise<boolean>;
    completeSessionAgentRun(input: {
        runId: string;
        status: 'completed' | 'failed' | 'canceled';
        resultSummary?: string | null;
        errorSummary?: string | null;
    }): Promise<void>;
    deleteSession(agentFolder: string, threadId?: string | null, metadata?: {
        appId?: string;
        conversationJid?: string;
        providerAccountId?: string | null;
        conversationKind?: 'dm' | 'channel';
        memoryUserId?: string;
        agentId?: string;
    }): Promise<void>;
    deleteSessionsByAgentFolder(agentFolder: string): Promise<void>;
    getConversationRoute(jid: string): Promise<ConversationRoute | undefined>;
    setConversationRoute(jid: string, group: ConversationRoute): Promise<void>;
    deleteConversationRoute(jid: string): Promise<void>;
    getAllConversationRoutes(): Promise<Record<string, ConversationRoute>>;
}
export {};
