import type { PermissionPromotionCounter, PermissionPromotionRepository } from '../../../../domain/ports/permission-promotion.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresPermissionPromotionRepository implements PermissionPromotionRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    incrementAndGet(input: {
        appId: string;
        agentFolder: string;
        suggestionKey: string;
        nowIso: string;
    }): Promise<PermissionPromotionCounter>;
    get(input: {
        appId: string;
        agentFolder: string;
        suggestionKey: string;
    }): Promise<PermissionPromotionCounter | null>;
    markOffered(input: {
        appId: string;
        agentFolder: string;
        suggestionKey: string;
        nowIso: string;
    }): Promise<boolean>;
    markDenied(input: {
        appId: string;
        agentFolder: string;
        suggestionKey: string;
        nowIso: string;
    }): Promise<void>;
}
