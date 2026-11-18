import * as schema from '../schema/schema.js';
import { queueRuntimeEventWakeup } from '../runtime-event-notifier.postgres.js';
import { sql } from 'drizzle-orm';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
/** Matches runtime-event allocation ordering so committed cursors cannot skip receipts. */
export async function lockSourceEventApp(tx: CanonicalExecutor, appId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${appId}, 0))`,
  );
}

/** Append the durable row and its commit-bound stream wakeup together. */
export async function appendSourceRuntimeEvent(
  tx: CanonicalExecutor,
  input: typeof schema.runtimeEventsPostgres.$inferInsert,
) {
  const rows = await tx
    .insert(schema.runtimeEventsPostgres)
    .values(input)
    .returning();
  for (const event of rows) await queueRuntimeEventWakeup(tx, event);
  return rows;
}
