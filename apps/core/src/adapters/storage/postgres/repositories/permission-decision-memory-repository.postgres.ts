import { and, eq, isNull, sql } from 'drizzle-orm';

import {
  AllowOnceNeverPersistedError,
  type ClassifierVerdict,
  type PermissionDecisionMemoryEffect,
  type PermissionDecisionMemoryKind,
  type PermissionDecisionMemoryPutInput,
  type PermissionDecisionMemoryRepository,
  type PermissionDecisionMemoryRow,
} from '../../../../domain/ports/permission-decision-memory.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const table = pgSchema.permissionDecisionMemoryPostgres;

/**
 * Refuse to persist an ephemeral human `allow_once`. Runnable guard on the single
 * write path — allow_once is never written to decision memory (PERM-2 tripwire).
 */
function assertPersistable(input: {
  sourceMode?: string;
  decision?: string;
}): void {
  if (input.sourceMode === 'allow_once' || input.decision === 'allow_once') {
    throw new AllowOnceNeverPersistedError();
  }
}

export class PostgresPermissionDecisionMemoryRepository implements PermissionDecisionMemoryRepository {
  constructor(private readonly db: CanonicalDb) {}

  async put(input: PermissionDecisionMemoryPutInput): Promise<void> {
    assertPersistable(input);
    await this.db
      .insert(table)
      .values({
        id: input.id,
        appId: input.appId,
        agentFolder: input.agentFolder,
        kind: input.kind,
        lookupIdentity: input.lookupIdentity,
        effectHash: input.effectHash ?? null,
        decision: input.decision ?? null,
        reason: input.reason,
        canonicalRoot: input.canonicalRoot ?? null,
        principal: input.principal ?? null,
        effectSchemaVersion: input.effectSchemaVersion,
        railVersion: input.railVersion,
        provenance: input.provenance,
        createdAt: input.nowIso,
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: [
          table.appId,
          table.agentFolder,
          table.kind,
          table.lookupIdentity,
        ],
        set: {
          effectHash: input.effectHash ?? null,
          decision: input.decision ?? null,
          reason: input.reason,
          canonicalRoot: input.canonicalRoot ?? null,
          principal: input.principal ?? null,
          effectSchemaVersion: input.effectSchemaVersion,
          railVersion: input.railVersion,
          provenance: input.provenance,
          expiresAt: input.expiresAt ?? null,
          // Re-activate a previously revoked row on rewrite.
          revokedAt: null,
        },
      });
  }

  async putClassifierVerdict(input: {
    appId: string;
    agentFolder: string;
    effectHash: string;
    decision: 'allow' | 'ask';
    reason: string;
    effectSchemaVersion: number;
    railVersion: number;
    provenance: string;
    nowIso: string;
    id?: string;
    expiresAt?: string;
    sourceMode?: string;
  }): Promise<void> {
    await this.put({
      id:
        input.id ??
        `pdm:${input.appId}:${input.agentFolder}:classifier_verdict:${input.effectHash}`,
      appId: input.appId,
      agentFolder: input.agentFolder,
      kind: 'classifier_verdict',
      lookupIdentity: input.effectHash,
      effectHash: input.effectHash,
      decision: input.decision,
      reason: input.reason,
      canonicalRoot: undefined,
      principal: undefined,
      effectSchemaVersion: input.effectSchemaVersion,
      railVersion: input.railVersion,
      provenance: input.provenance,
      nowIso: input.nowIso,
      expiresAt: input.expiresAt,
      sourceMode:
        input.sourceMode as PermissionDecisionMemoryPutInput['sourceMode'],
    });
  }

  async getClassifierVerdict(input: {
    appId: string;
    agentFolder: string;
    effectHash: string;
  }): Promise<ClassifierVerdict | null> {
    const row = await this.get({
      appId: input.appId,
      agentFolder: input.agentFolder,
      kind: 'classifier_verdict',
      lookupIdentity: input.effectHash,
    });
    if (!row || (row.decision !== 'allow' && row.decision !== 'ask')) {
      return null;
    }
    return { decision: row.decision, reason: row.reason };
  }

  async get(input: {
    appId: string;
    agentFolder: string;
    kind: PermissionDecisionMemoryKind;
    lookupIdentity: string;
  }): Promise<PermissionDecisionMemoryRow | null> {
    const [row] = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.agentFolder, input.agentFolder),
          eq(table.kind, input.kind),
          eq(table.lookupIdentity, input.lookupIdentity),
          isNull(table.revokedAt),
        ),
      )
      .limit(1);
    return row ? mapRow(row) : null;
  }

  async list(input: {
    appId: string;
    agentFolder: string;
    kind?: PermissionDecisionMemoryKind;
  }): Promise<PermissionDecisionMemoryRow[]> {
    const rows = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.agentFolder, input.agentFolder),
          isNull(table.revokedAt),
          input.kind ? eq(table.kind, input.kind) : undefined,
        ),
      );
    return rows.map(mapRow);
  }

  async revoke(input: {
    appId: string;
    agentFolder: string;
    kind: PermissionDecisionMemoryKind;
    lookupIdentity: string;
    nowIso: string;
  }): Promise<boolean> {
    const rows = await this.db
      .update(table)
      .set({ revokedAt: input.nowIso })
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.agentFolder, input.agentFolder),
          eq(table.kind, input.kind),
          eq(table.lookupIdentity, input.lookupIdentity),
          isNull(table.revokedAt),
        ),
      )
      .returning({ id: table.id });
    return rows.length === 1;
  }
}

/**
 * Row → domain hydration. Postgres returns NULL for the optional columns; coerce
 * NULL → undefined so downstream `=== undefined` checks work (CAP-1 lesson).
 */
function mapRow(row: typeof table.$inferSelect): PermissionDecisionMemoryRow {
  return {
    id: row.id,
    appId: row.appId,
    agentFolder: row.agentFolder,
    kind: row.kind as PermissionDecisionMemoryKind,
    lookupIdentity: row.lookupIdentity,
    effectHash: row.effectHash ?? undefined,
    decision: (row.decision ?? undefined) as
      | PermissionDecisionMemoryEffect
      | undefined,
    reason: row.reason,
    canonicalRoot: row.canonicalRoot ?? undefined,
    principal: row.principal ?? undefined,
    effectSchemaVersion: row.effectSchemaVersion,
    railVersion: row.railVersion,
    provenance: row.provenance,
    createdAt: toIsoTimestamp(row.createdAt),
    expiresAt: row.expiresAt ? toIsoTimestamp(row.expiresAt) : undefined,
    revokedAt: row.revokedAt ? toIsoTimestamp(row.revokedAt) : undefined,
  };
}

function toIsoTimestamp(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
