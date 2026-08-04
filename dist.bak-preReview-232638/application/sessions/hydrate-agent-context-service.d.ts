import type { AgentSessionDigestRepository, AgentSessionRepository } from '../../domain/ports/repositories.js';
import type { AgentSessionDigest, AgentSession, AgentSessionId } from '../../domain/sessions/sessions.js';
import { type ContinuitySectionName, type ContinuitySectionStatus } from './session-continuity-injection-status.js';
export type HydrationMode = 'first_visible' | 'full';
export interface HydrateAgentContextOptions {
    memoryItemLimit?: number;
    digestItemLimit?: number;
    maxChars?: number;
    hydrationMode?: HydrationMode;
    statementTimeoutMs?: number;
}
interface HydratedSessionDigest {
    id: string;
    source: 'session_digest';
    text: string;
    trigger?: AgentSessionDigest['trigger'];
    fromMessageId?: string;
    toMessageId?: string;
    fromRunId?: string;
    toRunId?: string;
    messageCount: number;
    runCount?: number;
    extractedFactCount?: number;
    metadata?: Record<string, unknown>;
    createdAt: string;
}
interface HydratedContextMemoryItem {
    id: string;
    kind: string;
    key: string;
    value: string;
    subject: unknown;
}
interface HydratedContinuityJob {
    id: string;
    name: string;
    status: 'active' | 'paused' | 'running' | 'dead_lettered';
    nextRunAt?: string;
    lastRunAt?: string;
    target?: unknown;
}
export interface HydrateAgentContextDependencies {
    digests?: AgentSessionDigestRepository;
    loadAppMemoryItems?: (input: {
        session: AgentSession;
        limit: number;
        conversationKind?: string;
        query?: string;
        hydrationMode: HydrationMode;
        statementTimeoutMs?: number;
    }) => Promise<HydratedContextMemoryItem[]>;
    loadContinuityJobs?: (input: {
        session: AgentSession;
        limit: number;
    }) => Promise<HydratedContinuityJob[]>;
    logContinuityEmptyUnexpected?: (metadata: Record<string, unknown>, message: 'continuity_empty_unexpected') => void;
}
export declare class HydrateAgentContextService {
    private readonly sessions;
    private readonly defaults;
    private readonly dependencies;
    constructor(sessions: AgentSessionRepository, defaults?: HydrateAgentContextOptions, dependencies?: HydrateAgentContextDependencies);
    hydrate(input: {
        sessionId: AgentSessionId;
        conversationKind?: string;
        query?: string;
        hydrationMode?: HydrationMode;
        options?: HydrateAgentContextOptions;
    }): Promise<{
        session: AgentSession;
        digests: HydratedSessionDigest[];
        memories: HydratedContextMemoryItem[];
        jobs: HydratedContinuityJob[];
        block: string;
        continuityStatus: {
            hydrationMode: HydrationMode;
            subject: {
                threadId?: string | undefined;
                userId?: import("../../domain/conversation/conversation.js").UserId | undefined;
                conversationId?: import("../../domain/conversation/conversation.js").ConversationId | undefined;
                appId: import("../../domain/app/app.js").AppId;
                agentId: import("../../domain/agent/agent.js").AgentId;
            };
            bytes: number;
            maxBytes: number;
            truncated: boolean;
            blockEmpty: boolean;
            sections: Record<ContinuitySectionName, {
                status: ContinuitySectionStatus;
                count: number;
                items: unknown[];
            }>;
        };
    }>;
    private loadRecentDigests;
    private loadMemories;
    private loadContinuityJobs;
}
export {};
