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
): Promise<number> {
  const memory = pgSchema.memoryItemsPostgres;
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
      and(
        eq(memory.appId, input.appId),
        eq(memory.subjectType, 'user'),
        eq(memory.userId, input.sourcePersonId),
      ),
    );
  return moved.rowCount ?? 0;
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
