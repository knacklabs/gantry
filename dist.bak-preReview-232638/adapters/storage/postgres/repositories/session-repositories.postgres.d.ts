import type { Agent } from '../../../../domain/agent/agent.js';
import type { App } from '../../../../domain/app/app.js';
import type { Conversation, ConversationThread } from '../../../../domain/conversation/conversation.js';
import type { AgentSessionRepository, AgentSessionDigestRepository, AgentSessionSummaryRepository, ProviderSessionRepository } from '../../../../domain/ports/repositories.js';
import type { AgentSessionDigest, AgentSessionDigestScopeMetadata, AgentSession, AgentSessionSummary, ExecutionProviderId, ProviderSession } from '../../../../domain/sessions/sessions.js';
import { type CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresAgentSessionRepository implements AgentSessionRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getAgentSession(id: AgentSession['id']): Promise<AgentSession | null>;
    getAgentSessionByKey(input: {
        appId: App['id'];
        agentId: Agent['id'];
        conversationId: Conversation['id'];
        threadId?: ConversationThread['id'];
        userId?: string;
    }): Promise<AgentSession | null>;
    saveAgentSession(session: AgentSession): Promise<void>;
    private writeAgentSession;
    private sessionFromRow;
}
export declare class PostgresProviderSessionRepository implements ProviderSessionRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getProviderSession(id: ProviderSession['id']): Promise<ProviderSession | null>;
    getLatestProviderSession(input: {
        agentSessionId: AgentSession['id'];
        provider?: ExecutionProviderId;
    }): Promise<ProviderSession | null>;
    saveProviderSession(session: ProviderSession): Promise<void>;
    markProviderSessionStatus(id: ProviderSession['id'], status: ProviderSession['status'], updatedAt: string): Promise<void>;
    private providerSessionFromRow;
}
export declare class PostgresAgentSessionSummaryRepository implements AgentSessionSummaryRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getAgentSessionSummary(id: AgentSessionSummary['id']): Promise<AgentSessionSummary | null>;
    getLatestAgentSessionSummary(agentSessionId: AgentSession['id']): Promise<AgentSessionSummary | null>;
    listRecentAgentSessionSummaries(input: {
        agentSessionId: AgentSession['id'];
        limit?: number;
    }): Promise<AgentSessionSummary[]>;
    saveAgentSessionSummary(summary: AgentSessionSummary): Promise<void>;
    private summaryFromRow;
}
export declare class PostgresAgentSessionDigestRepository implements AgentSessionDigestRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getAgentSessionDigest(id: AgentSessionDigest['id']): Promise<AgentSessionDigest | null>;
    listAgentSessionDigests(input: {
        agentSessionId: AgentSession['id'];
        trigger?: AgentSessionDigest['trigger'];
        sessionScope?: AgentSessionDigestScopeMetadata['sessionScope'];
        limit?: number;
    }): Promise<AgentSessionDigest[]>;
    saveAgentSessionDigest(digest: AgentSessionDigest): Promise<void>;
    private digestFromRow;
}
