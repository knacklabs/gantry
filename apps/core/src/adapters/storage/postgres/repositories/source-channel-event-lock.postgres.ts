import { sql } from 'drizzle-orm';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
/** Matches runtime-event allocation ordering so committed cursors cannot skip receipts. */
export async function lockSourceEventApp(tx: CanonicalExecutor, appId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${appId}, 0))`,
  );
}
