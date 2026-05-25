import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import {
  itemMatchesSubjectBoundary,
  parseJsonObject,
  parseItemSource,
  type CanonicalMemoryItemRow,
} from './app-memory-canonical-codec.js';
import { normalizeSubject, subjectIdFor } from './app-memory-boundaries.js';
import {
  nowIso,
  withStatementTimeout,
} from './app-memory-service-query-helpers.js';
import { hasDreamingStatusSubjectScope } from './app-memory-service-dreaming.js';
import { toRun } from './app-memory-service-record-mappers.js';
import type {
  DemoteDreamingMemoryInput,
  DeleteAppMemoryInput,
  DreamingRunStatus,
  MemoryBoundaryContext,
  MemorySubjectType,
  NormalizedMemorySubject,
} from './memory-types.js';

type Db = NodePgDatabase<typeof pgSchema>;

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
        sql`${pgSchema.memoryItemsPostgres.sourceRefJson} @> ${JSON.stringify({ subject: { agentId: input.subject.agentId, subjectType: input.subject.subjectType, subjectId: input.subject.subjectId } })}::jsonb`,
        eq(pgSchema.memoryItemsPostgres.key, input.key.trim()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listDreamingStatuses(
  db: Db,
  input: Partial<MemoryBoundaryContext> & {
    subjectType?: MemorySubjectType;
    subjectId?: string;
  } = {},
  options: { signal?: AbortSignal; statementTimeoutMs?: number } = {},
): Promise<DreamingRunStatus[]> {
  options.signal?.throwIfAborted();
  const hasSubjectScope = hasDreamingStatusSubjectScope(input);
  const subject = normalizeSubject(input);
  const subjectFilters = hasSubjectScope
    ? [
        eq(pgSchema.memoryDreamRunsPostgres.subjectType, subject.subjectType),
        eq(pgSchema.memoryDreamRunsPostgres.subjectId, subject.subjectId),
      ]
    : [];
  const rows = (await withStatementTimeout(
    db,
    options.statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (queryDb) =>
      queryDb
        .select()
        .from(pgSchema.memoryDreamRunsPostgres)
        .where(
          and(
            eq(pgSchema.memoryDreamRunsPostgres.appId, subject.appId),
            eq(pgSchema.memoryDreamRunsPostgres.agentId, subject.agentId),
            ...subjectFilters,
          ),
        )
        .orderBy(desc(pgSchema.memoryDreamRunsPostgres.startedAt))
        .limit(20),
  )) as Array<typeof pgSchema.memoryDreamRunsPostgres.$inferSelect>;
  options.signal?.throwIfAborted();
  return rows.map(toRun);
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
          : sql`(${pgSchema.memoryItemsPostgres.sourceRefJson}->>'version')::int = ${input.expectedVersion}`,
      ),
    )
    .returning({ id: pgSchema.memoryItemsPostgres.id });
  if (!deleted) throw new Error('stale memory delete');
  return { deleted: true };
}

export async function demoteDreamingPromotedMemoryItem(input: {
  db: Db;
  context: NormalizedMemorySubject;
  id: string;
  expectedVersion?: DemoteDreamingMemoryInput['expectedVersion'];
  isAdminWrite?: DemoteDreamingMemoryInput['isAdminWrite'];
  actorId?: DemoteDreamingMemoryInput['actorId'];
  reason?: DemoteDreamingMemoryInput['reason'];
}): Promise<{ demoted: boolean }> {
  const current = await getOwnedMemoryItem(input);
  if (!current) return { demoted: false };
  const currentSource = parseItemSource(current);
  if (currentSource.subject.subjectType === 'common' && !input.isAdminWrite) {
    throw new Error('common memory demotions require admin/service authority');
  }
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== currentSource.version
  ) {
    throw new Error('stale memory demotion');
  }
  const sourceRef = parseJsonObject(current.sourceRefJson);
  if (
    currentSource.source !== 'dreaming' ||
    sourceRef.promoted_by !== 'dreaming'
  ) {
    throw new Error('only dreaming-promoted memory can be demoted');
  }
  const timestamp = nowIso();
  const [demoted] = await input.db
    .update(pgSchema.memoryItemsPostgres)
    .set({
      status: 'demoted',
      sourceRefJson: {
        ...sourceRef,
        demoted_at: timestamp,
        demoted_by: input.actorId ?? null,
        demotion_reason: input.reason ?? null,
      },
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.id, current.id),
        eq(pgSchema.memoryItemsPostgres.status, 'active'),
        input.expectedVersion === undefined
          ? undefined
          : sql`(${pgSchema.memoryItemsPostgres.sourceRefJson}->>'version')::int = ${input.expectedVersion}`,
      ),
    )
    .returning({ id: pgSchema.memoryItemsPostgres.id });
  if (!demoted) throw new Error('stale memory demotion');
  return { demoted: true };
}

export type OwnedMemoryItemLookupInput = {
  id: string;
} & Partial<MemoryBoundaryContext>;
