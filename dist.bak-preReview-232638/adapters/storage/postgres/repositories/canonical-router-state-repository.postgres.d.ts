import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresCanonicalRouterStateRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
}
