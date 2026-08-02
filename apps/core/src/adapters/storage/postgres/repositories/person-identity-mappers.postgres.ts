import { createHash } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  AliasVerificationStatus,
  PersonAliasRecord,
  PersonMergeApplyResult,
  PersonMergeConflict,
  PersonMergeInput,
  PersonRecord,
} from '../../../../application/identity/person-identity-service.js';
import { ApplicationError } from '../../../../application/common/application-error.js';
import * as pgSchema from '../schema/schema.js';

type Db = NodePgDatabase<typeof pgSchema>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
type UserRow = typeof pgSchema.usersPostgres.$inferSelect;
type AliasRow = typeof pgSchema.userAliasesPostgres.$inferSelect;
type AuditRow = typeof pgSchema.personMergeAuditPostgres.$inferSelect;

const PERSON_STATUS = {
  active: 'active',
  disabled: 'disabled',
  archived: 'archived',
} as const;

export function stableId(prefix: string, parts: string[]): string {
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${prefix}:${hash.slice(0, 32)}`;
}

export function normalizeProviderAccountId(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function aliasStatus(row: AliasRow): AliasVerificationStatus {
  if (row.retiredAt) return 'retired';
  return row.verificationStatus === 'verified' ? 'verified' : 'unverified';
}

export function toAlias(row: AliasRow): PersonAliasRecord {
  return {
    id: row.id,
    appId: row.appId,
    personId: row.userId,
    provider: row.provider,
    providerAccountId: row.providerAccountId,
    externalUserId: row.externalUserId,
    displayName: row.displayName,
    verificationStatus: aliasStatus(row),
    verifiedAt: row.verifiedAt,
    verifiedBy: row.verifiedBy,
    retiredAt: row.retiredAt,
    retiredBy: row.retiredBy,
    evidence: jsonRecord(row.evidenceJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPerson(
  row: UserRow,
  aliases: PersonAliasRecord[] = [],
  memoryCounts = emptyMemoryCounts(),
): PersonRecord {
  const aliasCounts = { verified: 0, unverified: 0, retired: 0 };
  for (const alias of aliases) aliasCounts[alias.verificationStatus] += 1;
  return {
    personId: row.id,
    appId: row.appId,
    kind: row.kind === 'service' ? 'service' : 'human',
    displayName: row.displayName,
    status:
      row.status in PERSON_STATUS
        ? (row.status as PersonRecord['status'])
        : 'active',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    aliases,
    aliasCounts,
    memoryCounts,
  };
}

export function emptyMemoryCounts(): NonNullable<PersonRecord['memoryCounts']> {
  return {
    personal: 0,
    active: 0,
    archived: 0,
    superseded: 0,
    deleted: 0,
  };
}

export function memoryCountsFromRows(
  rows: Array<{ status: string; count: number }>,
): NonNullable<PersonRecord['memoryCounts']> {
  const counts = emptyMemoryCounts();
  for (const row of rows) {
    const value = Number(row.count || 0);
    counts.personal += value;
    if (row.status === 'active') counts.active += value;
    else if (row.status === 'archived') counts.archived += value;
    else if (row.status === 'superseded') counts.superseded += value;
    else if (row.status === 'deleted') counts.deleted += value;
  }
  return counts;
}

export async function ensureApp(
  executor: Executor,
  appId: string,
): Promise<void> {
  await executor
    .insert(pgSchema.appsPostgres)
    .values({
      id: appId,
      slug: appId,
      name: appId,
      status: 'active',
    })
    .onConflictDoNothing();
}

export async function lockPersonAliasKey(
  executor: Executor,
  input: {
    appId: string;
    provider: string;
    providerAccountId?: string | null;
    externalUserId: string;
  },
): Promise<void> {
  const key = JSON.stringify([
    'person-alias',
    input.appId,
    input.provider,
    normalizeProviderAccountId(input.providerAccountId) ?? '',
    input.externalUserId,
  ]);
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

export async function rekeyPersonalMemory(
  executor: Executor,
  input: PersonMergeInput & {
    conflictResolution: 'fail_on_conflict' | 'keep_target';
    conflictSourceIds: string[];
    timestamp: string;
  },
): Promise<{
  movedMemoryIds: string[];
  movedMemoryRows: Array<{ id: string; subjectId: string }>;
  supersededMemoryRows: Array<{ id: string; priorStatus: string }>;
}> {
  // Accepted residual: a turn that resolved the source person BEFORE the
  // merge can still write a personal row after this snapshot. No repository
  // lock can span a turn lifetime; such a row lands on the archived source,
  // which no longer resolves, so nothing leaks or re-surfaces.
  const memory = pgSchema.memoryItemsPostgres;
  const rows = await executor
    .select({
      id: memory.id,
      status: memory.status,
      subjectId: memory.subjectId,
    })
    .from(memory)
    .where(
      and(
        eq(memory.appId, input.appId),
        eq(memory.subjectType, 'user'),
        eq(memory.userId, input.sourcePersonId),
      ),
    )
    .orderBy(memory.id)
    .for('update');
  if (rows.length === 0) {
    return {
      movedMemoryIds: [],
      movedMemoryRows: [],
      supersededMemoryRows: [],
    };
  }
  const movedMemoryIds = rows.map((row) => row.id);
  const movedMemoryRows = rows.map((row) => ({
    id: row.id,
    subjectId: row.subjectId ?? '',
  }));
  const conflictSourceIds = new Set(input.conflictSourceIds);
  const supersededMemoryRows = rows
    .filter((row) => conflictSourceIds.has(row.id))
    .map((row) => ({ id: row.id, priorStatus: row.status }));
  const updates = {
    subjectId: sql<string>`'msu_' || substr(encode(digest(${memory.appId} || ':' || COALESCE(${memory.agentId}, 'agent:unknown') || ':user:' || ${input.targetPersonId}, 'sha256'), 'hex'), 1, 32)`,
    userId: input.targetPersonId,
    sourceRefJson: sql<
      Record<string, unknown>
    >`(CASE WHEN jsonb_typeof(${memory.sourceRefJson}) = 'object' THEN ${memory.sourceRefJson} ELSE '{}'::jsonb END) || jsonb_build_object('subject', (CASE WHEN jsonb_typeof(${memory.sourceRefJson}->'subject') = 'object' THEN ${memory.sourceRefJson}->'subject' ELSE '{}'::jsonb END) || jsonb_build_object('subjectType', 'user', 'subjectId', ${input.targetPersonId}::text, 'userId', ${input.targetPersonId}::text))`,
    updatedAt: input.timestamp,
    ...(input.conflictResolution === 'keep_target' &&
    input.conflictSourceIds.length > 0
      ? {
          status: sql<string>`CASE WHEN ${inArray(memory.id, input.conflictSourceIds)} THEN 'superseded' ELSE ${memory.status} END`,
        }
      : {}),
  };
  const moved = await executor
    .update(memory)
    .set(updates)
    .where(
      and(eq(memory.appId, input.appId), inArray(memory.id, movedMemoryIds)),
    );
  if ((moved.rowCount ?? 0) !== movedMemoryIds.length) {
    throw new ApplicationError(
      'CONFLICT',
      'Personal memory changed while the person merge was applied.',
    );
  }
  return { movedMemoryIds, movedMemoryRows, supersededMemoryRows };
}

export async function restorePersonalMemory(
  executor: Executor,
  input: {
    appId: string;
    sourcePersonId: string;
    targetPersonId: string;
    movedMemoryIds: string[];
    movedMemoryRows: Array<{ id: string; subjectId: string }>;
    supersededMemoryRows: Array<{ id: string; priorStatus: string }>;
    timestamp: string;
  },
): Promise<number> {
  if (input.movedMemoryIds.length === 0) return 0;
  const memory = pgSchema.memoryItemsPostgres;
  const rows = await executor
    .select({ id: memory.id })
    .from(memory)
    .where(
      and(
        eq(memory.appId, input.appId),
        eq(memory.subjectType, 'user'),
        eq(memory.userId, input.targetPersonId),
        inArray(memory.id, input.movedMemoryIds),
      ),
    )
    .orderBy(memory.id)
    .for('update');
  if (rows.length !== input.movedMemoryIds.length) {
    throw new ApplicationError(
      'CONFLICT',
      'Merge-owned personal memory is no longer intact; unmerge was refused.',
    );
  }
  // Restore each row's RECORDED pre-merge subject id: recomputing from the
  // source person would silently canonicalize any noncanonical original.
  const restoredIds = input.movedMemoryRows.map((row) => row.id);
  const restoredSubjects = input.movedMemoryRows.map((row) => row.subjectId);
  await executor.execute(sql`
    UPDATE ${memory} AS m
    SET subject_id = v.subject_id,
        user_id = ${input.sourcePersonId},
        source_ref_json = (CASE WHEN jsonb_typeof(m.source_ref_json) = 'object' THEN m.source_ref_json ELSE '{}'::jsonb END) || jsonb_build_object('subject', (CASE WHEN jsonb_typeof(m.source_ref_json->'subject') = 'object' THEN m.source_ref_json->'subject' ELSE '{}'::jsonb END) || jsonb_build_object('subjectType', 'user', 'subjectId', ${input.sourcePersonId}::text, 'userId', ${input.sourcePersonId}::text)),
        updated_at = ${input.timestamp}
    FROM (
      SELECT unnest(${restoredIds}::text[]) AS id,
             unnest(${restoredSubjects}::text[]) AS subject_id
    ) v
    WHERE m.id = v.id AND m.app_id = ${input.appId}
  `);
  if (input.supersededMemoryRows.length > 0) {
    const supersededIds = input.supersededMemoryRows.map((row) => row.id);
    const current = await executor
      .select({ id: memory.id, status: memory.status })
      .from(memory)
      .where(
        and(eq(memory.appId, input.appId), inArray(memory.id, supersededIds)),
      )
      .orderBy(memory.id)
      .for('update');
    const statusById = new Map(current.map((row) => [row.id, row.status]));
    const changed = supersededIds.filter(
      (id) => statusById.get(id) !== 'superseded',
    );
    if (changed.length > 0) {
      throw new ApplicationError(
        'CONFLICT',
        `Merge-superseded personal memory changed after the merge; unmerge was refused: ${changed.join(', ')}`,
      );
    }
  }
  const idsByStatus = new Map<string, string[]>();
  for (const row of input.supersededMemoryRows) {
    const ids = idsByStatus.get(row.priorStatus) ?? [];
    ids.push(row.id);
    idsByStatus.set(row.priorStatus, ids);
  }
  for (const [status, ids] of idsByStatus) {
    await executor
      .update(memory)
      .set({ status, updatedAt: input.timestamp })
      .where(and(eq(memory.appId, input.appId), inArray(memory.id, ids)));
  }
  return rows.length;
}

export async function findMergeAudit(
  executor: Executor,
  appId: string,
  idempotencyKey: string,
): Promise<AuditRow | null> {
  const [row] = await executor
    .select()
    .from(pgSchema.personMergeAuditPostgres)
    .where(
      and(
        eq(pgSchema.personMergeAuditPostgres.appId, appId),
        eq(pgSchema.personMergeAuditPostgres.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findMergeAuditByIdForUpdate(
  executor: Executor,
  appId: string,
  auditId: string,
): Promise<AuditRow | null> {
  const [row] = await executor
    .select()
    .from(pgSchema.personMergeAuditPostgres)
    .where(
      and(
        eq(pgSchema.personMergeAuditPostgres.appId, appId),
        eq(pgSchema.personMergeAuditPostgres.id, auditId),
      ),
    )
    .for('update')
    .limit(1);
  return row ?? null;
}

export interface MergeUndoSnapshot {
  sourcePerson: PersonRecord;
  aliasesToMove: PersonAliasRecord[];
  movedAliasIds: string[];
  movedMemoryIds: string[];
  movedMemoryRows: Array<{ id: string; subjectId: string }>;
  movedParticipantIds: string[];
  supersededMemoryRows: Array<{ id: string; priorStatus: string }>;
  fingerprint: string;
  unmergedAt?: string;
}

export function mergeUndoSnapshot(audit: AuditRow): MergeUndoSnapshot {
  const stored = jsonRecord(audit.resultJson);
  const source = jsonRecord(stored.sourcePerson);
  const aliasesToMove = jsonArray(stored.aliasesToMove);
  const movedAliasIds = jsonArray(stored.movedAliasIds);
  const movedMemoryIds = jsonArray(stored.movedMemoryIds);
  const supersededMemoryRows = jsonArray(stored.supersededMemoryRows);
  const movedMemoryRows = jsonArray(stored.movedMemoryRows);
  const movedParticipantIds = jsonArray(stored.movedParticipantIds);
  const validMovedParticipantIds =
    Array.isArray(stored.movedParticipantIds) &&
    movedParticipantIds.every((id) => typeof id === 'string');
  const validMovedMemoryRows =
    Array.isArray(stored.movedMemoryRows) &&
    movedMemoryRows.length === movedMemoryIds.length &&
    movedMemoryRows.every(
      (row) =>
        !!row &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        typeof (row as Record<string, unknown>).id === 'string' &&
        typeof (row as Record<string, unknown>).subjectId === 'string',
    ) &&
    [...movedMemoryRows]
      .map((row) => (row as Record<string, unknown>).id as string)
      .sort()
      .every(
        (id, index) => id === [...(movedMemoryIds as string[])].sort()[index],
      );
  const validSource =
    source.personId === audit.sourcePersonId &&
    source.appId === audit.appId &&
    (source.kind === 'human' || source.kind === 'service') &&
    source.status === 'active' &&
    (source.displayName === undefined ||
      source.displayName === null ||
      typeof source.displayName === 'string') &&
    typeof source.createdAt === 'string' &&
    typeof source.updatedAt === 'string';
  const validAliases = aliasesToMove.every(
    (alias) =>
      !!alias &&
      typeof alias === 'object' &&
      !Array.isArray(alias) &&
      typeof (alias as Record<string, unknown>).id === 'string' &&
      (alias as Record<string, unknown>).appId === audit.appId &&
      (alias as Record<string, unknown>).personId === audit.sourcePersonId,
  );
  const validSupersededRows = supersededMemoryRows.every(
    (row) =>
      !!row &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      typeof (row as Record<string, unknown>).id === 'string' &&
      typeof (row as Record<string, unknown>).priorStatus === 'string',
  );
  const aliasRecordIds = aliasesToMove.map((alias) =>
    alias && typeof alias === 'object' && !Array.isArray(alias)
      ? (alias as Record<string, unknown>).id
      : undefined,
  );
  const sortedAliasRecordIds = [...aliasRecordIds].sort();
  const sortedMovedAliasIds = [...movedAliasIds].sort();
  const aliasesMatch =
    aliasRecordIds.length === movedAliasIds.length &&
    sortedAliasRecordIds.every(
      (id, index) => id === sortedMovedAliasIds[index],
    );
  const memoryIdSet = new Set(movedMemoryIds);
  const uniqueAliasIds = new Set(movedAliasIds).size === movedAliasIds.length;
  const uniqueMemoryIds =
    new Set(movedMemoryIds).size === movedMemoryIds.length;
  if (
    !Array.isArray(stored.aliasesToMove) ||
    !Array.isArray(stored.movedAliasIds) ||
    !Array.isArray(stored.movedMemoryIds) ||
    !Array.isArray(stored.supersededMemoryRows) ||
    !validSource ||
    !validAliases ||
    !movedAliasIds.every((id) => typeof id === 'string') ||
    !movedMemoryIds.every((id) => typeof id === 'string') ||
    !validSupersededRows ||
    !validMovedMemoryRows ||
    !validMovedParticipantIds ||
    !aliasesMatch ||
    !uniqueAliasIds ||
    !uniqueMemoryIds ||
    supersededMemoryRows.some(
      (row) => !memoryIdSet.has((row as Record<string, unknown>).id),
    ) ||
    typeof stored.fingerprint !== 'string' ||
    !stored.fingerprint ||
    (stored.unmergedAt !== undefined && typeof stored.unmergedAt !== 'string')
  ) {
    throw new ApplicationError(
      'CONFLICT',
      'Merge audit does not contain the complete reversible state.',
    );
  }
  return {
    sourcePerson: source as unknown as PersonRecord,
    aliasesToMove: aliasesToMove as PersonAliasRecord[],
    movedAliasIds: movedAliasIds as string[],
    movedMemoryIds: movedMemoryIds as string[],
    movedMemoryRows: movedMemoryRows as Array<{
      id: string;
      subjectId: string;
    }>,
    movedParticipantIds: movedParticipantIds as string[],
    supersededMemoryRows: supersededMemoryRows as Array<{
      id: string;
      priorStatus: string;
    }>,
    fingerprint: stored.fingerprint,
    ...(typeof stored.unmergedAt === 'string'
      ? { unmergedAt: stored.unmergedAt }
      : {}),
  };
}

export function auditToMergeApply(
  audit: AuditRow,
  idempotencyKey: string,
  applied: boolean,
): PersonMergeApplyResult {
  const stored = jsonRecord(audit.resultJson);
  const excluded = jsonRecord(stored.excludedMemoryScopes);
  return {
    summary:
      'Person merge completed. Personal memory and aliases now belong to the target person.',
    sourcePersonId: audit.sourcePersonId,
    targetPersonId: audit.targetPersonId,
    aliasesToMove: jsonArray(stored.aliasesToMove) as PersonAliasRecord[],
    memoryRowsToMove: audit.memoryRowsMoved,
    excludedMemoryScopes: {
      group: Number(excluded.group ?? 0),
      channel: Number(excluded.channel ?? 0),
      common: Number(excluded.common ?? 0),
    },
    conflicts: jsonArray(audit.conflictsJson) as PersonMergeConflict[],
    fingerprint:
      typeof stored.fingerprint === 'string' ? stored.fingerprint : undefined,
    idempotencyKey,
    auditId: audit.id,
    applied,
  };
}

export function assertMergeAuditMatches(
  audit: AuditRow,
  input: PersonMergeInput,
  conflictResolution: 'fail_on_conflict' | 'keep_target',
): void {
  if (
    audit.sourcePersonId !== input.sourcePersonId ||
    audit.targetPersonId !== input.targetPersonId ||
    audit.conflictResolution !== conflictResolution
  ) {
    throw new ApplicationError(
      'CONFLICT',
      'idempotencyKey already belongs to a different person merge.',
    );
  }
  if (
    input.expectedFingerprint &&
    storedFingerprint(audit) !== input.expectedFingerprint
  ) {
    throw new ApplicationError(
      'CONFLICT',
      'Merge preview is stale; run preview again before applying the merge.',
    );
  }
}

function storedFingerprint(audit: AuditRow): string | undefined {
  const stored = jsonRecord(audit.resultJson);
  return typeof stored.fingerprint === 'string'
    ? stored.fingerprint
    : undefined;
}
