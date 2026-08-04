import type { Message } from '../domain/messages/messages.js';
import { type AgentSession } from '../domain/sessions/sessions.js';
import type { AgentSessionDigest } from '../domain/sessions/sessions.js';
import type { MemoryBoundaryTurn, MemoryBoundaryDefaultScope, SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
import type { ArcExtractionInput, ExtractedMemoryFact, MemoryExtractionResult } from './extractor-types.js';
interface BoundaryMemoryRepositories {
    agentSessions: {
        getAgentSession: (id: AgentSession['id']) => Promise<AgentSession | null | undefined>;
    };
    messages: {
        listRecentMessages: (input: {
            conversationId: NonNullable<AgentSession['conversationId']>;
            threadId: AgentSession['threadId'];
            limit: number;
        }) => Promise<Message[]>;
    };
    memory: {
        listPriorMemoryItems: (input: {
            session: AgentSession;
            limit: number;
            defaultScope?: MemoryBoundaryDefaultScope;
        }) => Promise<Array<{
            id: string;
            key: string;
            value: string;
            isDeleted?: boolean;
        }>>;
        saveBoundaryEvidence: (input: {
            appId: string;
            agentId: string;
            subjectType: 'user' | 'group' | 'channel';
            subjectId: string;
            userId?: string;
            groupId?: string;
            channelId?: string;
            sourceId: string;
            text: string;
            metadata: Record<string, unknown>;
        }) => Promise<{
            id: string;
        }>;
    };
    sessionDigests: {
        saveAgentSessionDigest: (digest: AgentSessionDigest) => Promise<void>;
    };
}
export declare function collectDurableMemoryFromRepositories(input: {
    agentSessionId: string;
    trigger: Parameters<SessionMemoryCollector>[0]['trigger'];
    repositories: BoundaryMemoryRepositories;
    extractFacts: (input: ArcExtractionInput) => Promise<ExtractedMemoryFact[] | MemoryExtractionResult> | ExtractedMemoryFact[] | MemoryExtractionResult;
    defaultScope?: MemoryBoundaryDefaultScope;
    additionalTurns?: MemoryBoundaryTurn[];
    nowIso?: () => string;
    signal?: AbortSignal;
    timeoutMs?: number;
    statementTimeoutMs?: number;
}): Promise<{
    saved: number;
}>;
export {};
