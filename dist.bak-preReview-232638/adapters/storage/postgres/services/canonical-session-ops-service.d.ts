import { type HydrationMode } from '../../../../application/sessions/hydrate-agent-context-service.js';
import type { AgentSessionDigestRepository, AgentSessionRepository, ConversationRepository } from '../../../../domain/ports/repositories.js';
import type { AgentSession, ExecutionProviderId } from '../../../../domain/sessions/sessions.js';
import type { PostgresCanonicalSessionRepository } from '../repositories/canonical-session-repository.postgres.js';
type SessionAppMemoryLoaderInput = {
    session: AgentSession;
    limit: number;
    conversationKind?: string;
    query?: string;
    hydrationMode: HydrationMode;
    statementTimeoutMs?: number;
};
type HydratedAppMemoryItem = {
    id: string;
    kind: string;
    key: string;
    value: string;
    subject: Record<string, unknown>;
};
type HydratedContinuityJob = {
    id: string;
    name: string;
    status: 'active' | 'paused' | 'running' | 'dead_lettered';
    nextRunAt?: string;
    lastRunAt?: string;
    target?: unknown;
};
export declare class CanonicalSessionOpsService {
    private readonly repository;
    private readonly hydrateService?;
    private readonly continuityJobOps?;
    private readonly conversations?;
    constructor(repository: PostgresCanonicalSessionRepository, repositories?: {
        agentSessions: AgentSessionRepository;
        agentSessionDigests?: AgentSessionDigestRepository;
        conversations?: ConversationRepository;
        loadAppMemoryItems?: (input: SessionAppMemoryLoaderInput) => Promise<HydratedAppMemoryItem[]>;
        loadContinuityJobs?: (input: {
            session: AgentSession;
            limit: number;
        }) => Promise<HydratedContinuityJob[]>;
    }, options?: {
        memoryItemLimit?: number;
        maxMemoryContextChars?: number;
    });
    setSession(workspaceFolder: string, sessionId: string, threadId: string | null | undefined, metadata: {
        appId?: string;
        executionProviderId: ExecutionProviderId;
        chatJid?: string;
        providerAccountId?: string | null;
        conversationKind?: 'dm' | 'channel';
        memoryUserId?: string;
        jobId?: string;
        expectedAgentSessionId?: string;
        expectedAgentSessionResetAt?: string | null;
        accessFingerprint?: string;
    }): Promise<boolean>;
    getAgentTurnContext(input: {
        appId?: string;
        workspaceFolder: string;
        executionProviderId: ExecutionProviderId;
        chatJid: string;
        providerAccountId?: string | null;
        threadId?: string | null;
        conversationKind?: 'dm' | 'channel';
        memoryUserId?: string;
        jobId?: string;
        query?: string;
        hydrateMemory?: boolean;
        hydrationMode?: HydrationMode;
        promoteReadyProviderSession?: boolean;
    }): Promise<{
        appId: string;
        agentId: string;
        agentSessionId: string;
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
        agentSessionResetAt?: string | null;
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
    deleteSession(workspaceFolder: string, threadId?: string | null, metadata?: {
        appId?: string;
        chatJid?: string;
        providerAccountId?: string | null;
        conversationKind?: 'dm' | 'channel';
        memoryUserId?: string;
        agentId?: string;
    }): Promise<void>;
    deleteSessionsByWorkspaceFolder(workspaceFolder: string): Promise<void>;
    private loadProductionContinuityJobs;
    private conversationJidForSession;
}
export {};
