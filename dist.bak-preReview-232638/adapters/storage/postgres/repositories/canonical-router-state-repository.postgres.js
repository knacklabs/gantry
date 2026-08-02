import { eq, sql } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
export class PostgresCanonicalRouterStateRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async get(key) {
        const rows = await this.db
            .select({ value: pgSchema.routerStatePostgres.value })
            .from(pgSchema.routerStatePostgres)
            .where(eq(pgSchema.routerStatePostgres.key, key))
            .limit(1);
        return rows[0]?.value;
    }
    async set(key, value) {
        await this.db
            .insert(pgSchema.routerStatePostgres)
            .values({ key, value })
            .onConflictDoUpdate({
            target: pgSchema.routerStatePostgres.key,
            set: { value: sql `excluded.value` },
        });
    }
}
