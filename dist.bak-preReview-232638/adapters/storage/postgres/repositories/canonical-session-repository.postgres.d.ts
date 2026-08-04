import { type CanonicalDb } from './canonical-graph-repository.postgres.js';
import { buildCurrentScopeResetMatcher, makeOwnedAgentSessionScopeKey, type ProviderSessionMaintenanceFinishInput, type ProviderSessionMaintenanceInput } from './canonical-session-repository-helpers.postgres.js';
import type { ExecutionProviderId } from '../../../../domain/sessions/sessions.js';
export { buildCurrentScopeResetMatcher, makeOwnedAgentSessionScopeKey };
export declare class PostgresCanonicalSessionRepository {
    private readonly db;
    private readonly graph;
    constructor(db: CanonicalDb);
    getAgentTurnContext(input: {
        appId?: string;
        workspaceFolder: string;
        executionProviderId: ExecutionProviderId;
        chatJid: string;
        providerAccountId?: string | null;
        threadId?: string | null;
        scopeKey: string;
        conversationKind?: 'dm' | 'channel';
        memoryUserId?: string;
        jobId?: string;
        promoteReadyProviderSession?: boolean;
    }): Promise<{
        providerSessionId?: string;
        externalSessionId?: string;
        latestProviderSessionLocked?: boolean;
        lockedProviderSessionId?: string;
        latestProviderSessionReady?: boolean;
        readyProviderSessionId?: string;
        readyExternalSessionId?: string;
        providerSessionAccessFingerprint?: string;
        compactionDeltaReplay?: {
            status: "pending" | "applied" | "degraded";
            baseCursor?: string;
            lockedAt?: string;
        };
        appId: string;
        agentId: string;
        agentSessionId: string;
        agentSessionResetAt: string | null;
    }>;
    private ensureAgentSession;
    private resolveSessionRoute;
    private ensureAppThread;
    private resolveBoundAgentId;
    private findBoundAgentId;
    setProviderSession(input: {
        appId?: string;
        workspaceFolder: string;
        executionProviderId: ExecutionProviderId;
        scopeKey: string;
        sessionId: string;
        chatJid?: string;
        providerAccountId?: string | null;
        threadId?: string | null;
        conversationKind?: 'dm' | 'channel';
        memoryUserId?: string;
        jobId?: string;
        expectedAgentSessionId?: string;
        expectedAgentSessionResetAt?: string | null;
        accessFingerprint?: string;
    }): Promise<boolean>;
    expireProviderSession(input: ProviderSessionMaintenanceInput): Promise<void>;
    markProviderSessionMaintenance(input: ProviderSessionMaintenanceInput): Promise<boolean>;
    markProviderSessionDeltaReplay(input: ProviderSessionMaintenanceInput & {
        status: 'applied' | 'degraded';
        reason?: string;
    }): Promise<void>;
    finishProviderSessionMaintenance(input: ProviderSessionMaintenanceFinishInput): Promise<void>;
    resetScope(input: {
        appId?: string;
        scopeKey: string;
        chatJid?: string;
        threadId?: string | null;
        agentId?: string;
    }): Promise<void>;
    deleteWorkspaceFolder(agentFolder: string): Promise<void>;
}
