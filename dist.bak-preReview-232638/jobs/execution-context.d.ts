import type { Job, ConversationRoute as RuntimeConversationRecord } from '../domain/types.js';
import type { RuntimeAgentSessionRepository } from '../domain/repositories/ops-repo.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
export declare function resolveExecutionContext(job: Job, groups: Record<string, RuntimeConversationRecord>): {
    group: RuntimeConversationRecord;
    executionJid: string;
    threadId: string | null;
    stopAliasJids: string[];
} | null;
export declare function resolveJobExecutionAgentId(job: Job): string | undefined;
export declare function resolveExecutionMemoryContext(input: {
    conversationKind?: RuntimeConversationRecord['conversationKind'];
    executionJid: string;
}): {
    memoryDefaultScope: 'user' | 'group';
    memoryUserId?: string;
};
export declare function buildExecutionTurnContextInput(input: {
    agentFolder: string;
    executionProviderId: ExecutionProviderId;
    executionJid: string;
    threadId?: string | null;
    conversationKind?: RuntimeConversationRecord['conversationKind'];
    memoryUserId?: string;
    jobId?: string;
    query?: string;
}): Parameters<NonNullable<RuntimeAgentSessionRepository['getAgentTurnContext']>>[0];
export declare function parseTriggerRequesterSessionId(requestedBy: string): string | null;
