import type { AppId } from '../../../../domain/app/app.js';
import type { PendingAccessRequestsRepository } from '../../../../domain/ports/repositories.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresPendingAccessRequestsRepository implements PendingAccessRequestsRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    insertPending(input: {
        id: string;
        appId: AppId;
        agentId: string;
        requestedBy: string;
        target: unknown;
        now?: string;
    }): Promise<void>;
    markResolved(input: {
        appId: AppId;
        id: string;
        resolution: 'approved' | 'denied';
        now?: string;
    }): Promise<void>;
    countPendingAccessRequests(input: {
        appId: AppId;
    }): Promise<number>;
}
