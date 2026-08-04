import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
export declare function ensureControlGraph(db: CanonicalExecutor, input: {
    appId: string;
    externalConversationId: string;
    externalConversationRef: string;
    agentFolder: string;
    title?: string | null;
}): Promise<{
    agentId: string;
    conversationId: string;
}>;
