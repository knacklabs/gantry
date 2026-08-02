import type { ConversationRoute } from '../../../../domain/repositories/domain-types.js';
import { type PostgresCanonicalBindingRepository } from '../repositories/canonical-binding-repository.postgres.js';
export declare class CanonicalBindingOpsService {
    private readonly repository;
    constructor(repository: PostgresCanonicalBindingRepository);
    getConversationRoute(jid: string): Promise<ConversationRoute | undefined>;
    setConversationRoute(jid: string, group: ConversationRoute): Promise<void>;
    deleteConversationRoute(jid: string): Promise<void>;
    getAllConversationRoutes(): Promise<Record<string, ConversationRoute>>;
}
