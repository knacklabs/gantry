import { eq, sql } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export class PostgresCanonicalRouterStateRepository {
  constructor(private readonly db: CanonicalDb) {}

  async get(key: string): Promise<string | undefined> {
    const rows = await this.db
      .select({ value: pgSchema.routerStatePostgres.value })
      .from(pgSchema.routerStatePostgres)
      .where(eq(pgSchema.routerStatePostgres.key, key))
      .limit(1);
    return rows[0]?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(pgSchema.routerStatePostgres)
      .values({ key, value })
      .onConflictDoUpdate({
        target: pgSchema.routerStatePostgres.key,
        set: { value: sql`excluded.value` },
      });
  }
}
