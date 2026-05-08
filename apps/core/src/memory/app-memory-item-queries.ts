import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import {
  itemMatchesSubjectBoundary,
  parseItemSource,
  type CanonicalMemoryItemRow,
} from './app-memory-canonical-codec.js';
import { subjectIdFor } from './app-memory-boundaries.js';
import {
  createSqlThreadIdentityFilter,
  nowIso,
} from './app-memory-service-query-helpers.js';
import type {
  DeleteAppMemoryInput,
  MemoryBoundaryContext,
  NormalizedMemorySubject,
} from './memory-types.js';

type Db = NodePgDatabase<typeof pgSchema>;
const sqlThreadIdentityFilter = createSqlThreadIdentityFilter({
  eq,
  isNull,
});

export async function findActiveMemoryByKey(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  key: string;
}): Promise<CanonicalMemoryItemRow | null> {
  const rows = await input.db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.status, 'active'),
        eq(pgSchema.memoryItemsPostgres.appId, input.subject.appId),
        eq(pgSchema.memoryItemsPostgres.agentId, input.subject.agentId),
        eq(pgSchema.memoryItemsPostgres.subjectType, input.subject.subjectType),
        eq(pgSchema.memoryItemsPostgres.subjectId, subjectIdFor(input.subject)),
        sql`${pgSchema.memoryItemsPostgres.sourceRefJson}::jsonb @> ${JSON.stringify({ subject: { agentId: input.subject.agentId, subjectType: input.subject.subjectType, subjectId: input.subject.subjectId } })}::jsonb`,
        sqlThreadIdentityFilter(
          pgSchema.memoryItemsPostgres,
          input.subject.threadId,
        ),
        eq(pgSchema.memoryItemsPostgres.key, input.key.trim()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getOwnedMemoryItem(input: {
  db: Db;
  context: NormalizedMemorySubject;
  id: string;
}): Promise<CanonicalMemoryItemRow | null> {
  const rows = await input.db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.id, input.id),
        eq(pgSchema.memoryItemsPostgres.status, 'active'),
        eq(pgSchema.memoryItemsPostgres.appId, input.context.appId),
      ),
    )
    .limit(1);
  const row = rows[0] ?? null;
  return row && itemMatchesSubjectBoundary(row, input.context) ? row : null;
}

export async function deleteOwnedMemoryItem(input: {
  db: Db;
  context: NormalizedMemorySubject;
  id: string;
  expectedVersion?: DeleteAppMemoryInput['expectedVersion'];
  isAdminWrite?: DeleteAppMemoryInput['isAdminWrite'];
}): Promise<{ deleted: boolean }> {
  const current = await getOwnedMemoryItem(input);
  if (!current) return { deleted: false };
  const currentSource = parseItemSource(current);
  if (currentSource.subject.subjectType === 'common' && !input.isAdminWrite) {
    throw new Error('common memory deletes require admin/service authority');
  }
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== currentSource.version
  ) {
    throw new Error('stale memory delete');
  }
  const [deleted] = await input.db
    .update(pgSchema.memoryItemsPostgres)
    .set({ status: 'deleted', updatedAt: nowIso() })
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.id, current.id),
        input.expectedVersion === undefined
          ? undefined
          : sql`(${pgSchema.memoryItemsPostgres.sourceRefJson}::jsonb->>'version')::int = ${input.expectedVersion}`,
      ),
    )
    .returning({ id: pgSchema.memoryItemsPostgres.id });
  if (!deleted) throw new Error('stale memory delete');
  return { deleted: true };
}

export type OwnedMemoryItemLookupInput = {
  id: string;
} & Partial<MemoryBoundaryContext>;
