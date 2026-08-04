import type { ConversationRoute } from '../../../../domain/repositories/domain-types.js';
import { type CanonicalDb } from './canonical-graph-repository.postgres.js';
export interface CanonicalBindingRecord {
    id: string;
    agentId: string;
    providerAccountId: string;
    conversationId: string;
    threadId: string | null;
    status: string;
    conversationExternalRefJson: string | null;
    conversationKind: string;
    memorySubjectJson: string;
    displayName: string;
    createdAt: string;
    updatedAt?: string;
}
export declare function conversationRouteKeyFromBindingRow(row: Pick<CanonicalBindingRecord, 'id'>): string | undefined;
export declare function normalizeRouteAgentId(agentId: string): string;
export declare class PostgresCanonicalBindingRepository {
    private readonly db;
    private readonly graph;
    constructor(db: CanonicalDb);
    saveConversationRoute(jid: string, group: ConversationRoute): Promise<void>;
    deleteConversationRoute(jid: string): Promise<void>;
    listConversationRoutes(): Promise<CanonicalBindingRecord[]>;
}
export declare function bindingRowToGroup(row: CanonicalBindingRecord): {
    jid: string;
    group: ConversationRoute;
} | undefined;
