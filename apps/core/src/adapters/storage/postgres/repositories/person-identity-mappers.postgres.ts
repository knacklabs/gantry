import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  AliasVerificationStatus,
  PersonAliasRecord,
  PersonMergeApplyResult,
  PersonMergeConflict,
  PersonMergePreview,
  PersonRecord,
} from '../../../../application/identity/person-identity-service.js';
import * as pgSchema from '../schema/schema.js';

type Db = NodePgDatabase<typeof pgSchema>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
type UserRow = typeof pgSchema.usersPostgres.$inferSelect;
type AliasRow = typeof pgSchema.userAliasesPostgres.$inferSelect;
type MemoryRow = typeof pgSchema.memoryItemsPostgres.$inferSelect;
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

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function personalMemorySubjectHash(input: {
  appId: string;
  agentId: string | null;
  personId: string;
}): string {
  const agentId = input.agentId || 'agent:unknown';
  return `msu_${hashText(`${input.appId}:${agentId}:user:${input.personId}`).slice(0, 32)}`;
}

export function normalizeProviderConnectionId(
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
    providerConnectionId: row.providerConnectionId,
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

function parseMemorySource(row: MemoryRow): Record<string, unknown> {
  return jsonRecord(row.sourceRefJson);
}

function sourceSubject(
  source: Record<string, unknown>,
): Record<string, unknown> {
  return jsonRecord(source.subject);
}

export function retargetMemorySource(
  row: MemoryRow,
  targetPersonId: string,
): Record<string, unknown> {
  const source = parseMemorySource(row);
  return {
    ...source,
    subject: {
      ...sourceSubject(source),
      subjectType: 'user',
      subjectId: targetPersonId,
      userId: targetPersonId,
    },
  };
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

export function auditToMergeApply(
  audit: AuditRow,
  preview: PersonMergePreview,
  idempotencyKey: string,
  applied: boolean,
  movedOverride?: number,
): PersonMergeApplyResult {
  return {
    summary:
      'Person merge completed. Personal memory and aliases now belong to the target person.',
    sourcePersonId: audit.sourcePersonId,
    targetPersonId: audit.targetPersonId,
    aliasesToMove: preview.aliasesToMove,
    memoryRowsToMove: movedOverride ?? audit.memoryRowsMoved,
    excludedMemoryScopes: preview.excludedMemoryScopes,
    conflicts: jsonArray(audit.conflictsJson) as PersonMergeConflict[],
    idempotencyKey,
    auditId: audit.id,
    applied,
  };
}
