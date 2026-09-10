import {
  and,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import {
  AllowOnceNeverPersistedError,
  type ClassifierVerdict,
  HUMAN_DECISION_MEMORY_KIND,
  HumanDecisionOutcome,
  HumanDecisionRequiresTypedAccessError,
  HumanDecisionScope,
  type HumanDecisionMemoryCandidate,
  type HumanDecisionMemoryPutInput,
  type HumanDecisionMemoryPutResult,
  type HumanDecisionRevokeResult,
  type PermissionDecisionMemoryEffect,
  type PermissionDecisionMemoryKind,
  type PermissionDecisionMemoryPutInput,
  type PermissionDecisionMemoryRepository,
  type PermissionDecisionMemoryRow,
} from '../../../../domain/ports/permission-decision-memory.js';
import { isHumanDecisionId } from '../../../../shared/human-decision-id.js';
import { encodeHumanDecisionProvenance } from '../../../../domain/human-decision.js';
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

function assertNonHumanKind(
  kind: PermissionDecisionMemoryKind | undefined,
): void {
  if (kind === HUMAN_DECISION_MEMORY_KIND) {
    throw new HumanDecisionRequiresTypedAccessError();
  }
}

function assertHumanDecisionInput(input: HumanDecisionMemoryPutInput): void {
  if (
    !isHumanDecisionId(input.id) ||
    (input.outcome !== HumanDecisionOutcome.Allow &&
      input.outcome !== HumanDecisionOutcome.Deny) ||
    (input.scope !== HumanDecisionScope.Exact &&
      input.scope !== HumanDecisionScope.Kind &&
      input.scope !== HumanDecisionScope.Place) ||
    !input.scopeKey?.trim() ||
    !input.actingPersonId?.trim() ||
    !input.canonicalTool?.trim()
  ) {
    throw new TypeError('Invalid human permission decision memory input');
  }
}

export class PostgresPermissionDecisionMemoryRepository implements PermissionDecisionMemoryRepository {
  constructor(private readonly db: CanonicalDb) {}

  async put(input: PermissionDecisionMemoryPutInput): Promise<void> {
    assertNonHumanKind(input.kind);
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
        riskLevel: input.risk_level ?? null,
        riskCategory: input.risk_category ?? null,
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
        targetWhere: sql`${table.kind} <> 'human_decision'`,
        set: {
          effectHash: input.effectHash ?? null,
          decision: input.decision ?? null,
          reason: input.reason,
          riskLevel: input.risk_level ?? null,
          riskCategory: input.risk_category ?? null,
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

  async putHumanDecision(
    input: HumanDecisionMemoryPutInput,
  ): Promise<HumanDecisionMemoryPutResult> {
    assertHumanDecisionInput(input);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
          'permission_decision_memory_human',
          input.appId,
          input.agentFolder,
          input.actingPersonId,
          input.scope,
          input.scopeKey,
        ])}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.appId, input.appId),
            eq(table.agentFolder, input.agentFolder),
            eq(table.kind, HUMAN_DECISION_MEMORY_KIND),
            eq(table.actingPersonId, input.actingPersonId),
            eq(table.scope, input.scope),
            eq(table.scopeKey, input.scopeKey),
            isNull(table.revokedAt),
          ),
        )
        .limit(1)
        .for('update');
      const id = existing?.id ?? input.id;
      const provenance = encodeHumanDecisionProvenance({
        id,
        actingPersonId: input.actingPersonId,
        outcome: input.outcome,
        scope: input.scope,
        railVersion: input.railVersion,
      });
      if (existing) {
        await tx
          .update(table)
          .set({
            outcome: input.outcome,
            decision: input.outcome,
            reason: input.reason,
            actingPersonLabel: input.actingPersonLabel ?? null,
            principal: input.canonicalTool,
            effectHash: input.effectHash ?? null,
            railVersion: input.railVersion,
            effectSchemaVersion: input.effectSchemaVersion,
            createdAt: input.nowIso,
            provenance,
          })
          .where(and(eq(table.id, id), isNull(table.revokedAt)));
        return { id, status: 'refreshed' };
      }
      await tx.insert(table).values({
        id,
        appId: input.appId,
        agentFolder: input.agentFolder,
        kind: HUMAN_DECISION_MEMORY_KIND,
        lookupIdentity: input.scopeKey,
        effectHash: input.effectHash ?? null,
        decision: input.outcome,
        outcome: input.outcome,
        scope: input.scope,
        scopeKey: input.scopeKey,
        actingPersonId: input.actingPersonId,
        actingPersonLabel: input.actingPersonLabel ?? null,
        reason: input.reason,
        riskLevel: null,
        riskCategory: null,
        canonicalRoot: null,
        principal: input.canonicalTool,
        effectSchemaVersion: input.effectSchemaVersion,
        railVersion: input.railVersion,
        provenance,
        createdAt: input.nowIso,
        expiresAt: null,
        revokedAt: null,
      });
      return { id, status: 'inserted' };
    });
  }

  async listHumanDecisions(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
    railVersion: number;
    includeRevoked?: boolean;
  }): Promise<PermissionDecisionMemoryRow[]> {
    const rows = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.agentFolder, input.agentFolder),
          eq(table.kind, HUMAN_DECISION_MEMORY_KIND),
          eq(table.actingPersonId, input.actingPersonId),
          eq(table.railVersion, input.railVersion),
          input.includeRevoked ? undefined : isNull(table.revokedAt),
        ),
      )
      .orderBy(desc(table.createdAt));
    return rows.map(mapRow);
  }

  async findHumanDecision(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
    candidates: HumanDecisionMemoryCandidate[];
    railVersion: number;
  }): Promise<PermissionDecisionMemoryRow | null> {
    if (input.candidates.length === 0) return null;
    const rows = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.agentFolder, input.agentFolder),
          eq(table.kind, HUMAN_DECISION_MEMORY_KIND),
          eq(table.actingPersonId, input.actingPersonId),
          eq(table.railVersion, input.railVersion),
          isNull(table.revokedAt),
          or(
            ...input.candidates.map((candidate) =>
              and(
                eq(table.scope, candidate.scope),
                eq(table.scopeKey, candidate.scopeKey),
              ),
            ),
          ),
        ),
      );
    for (const candidate of input.candidates) {
      const row = rows.find(
        (entry) =>
          entry.scope === candidate.scope &&
          entry.scopeKey === candidate.scopeKey,
      );
      if (row) return mapRow(row);
    }
    return null;
  }

  async revokeById(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
    recordId: string;
    nowIso: string;
  }): Promise<HumanDecisionRevokeResult> {
    const revoked = await this.db
      .update(table)
      .set({ revokedAt: input.nowIso })
      .where(
        and(
          eq(table.id, input.recordId),
          eq(table.appId, input.appId),
          eq(table.agentFolder, input.agentFolder),
          eq(table.kind, HUMAN_DECISION_MEMORY_KIND),
          eq(table.actingPersonId, input.actingPersonId),
          isNull(table.revokedAt),
        ),
      )
      .returning({ id: table.id });
    if (revoked.length === 1) return 'applied';
    const [existing] = await this.db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.id, input.recordId),
          eq(table.appId, input.appId),
          eq(table.agentFolder, input.agentFolder),
          eq(table.kind, HUMAN_DECISION_MEMORY_KIND),
          eq(table.actingPersonId, input.actingPersonId),
        ),
      )
      .limit(1);
    return existing ? 'already_revoked' : 'not_found';
  }

  async countExactAllowsByTool(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
    railVersion: number;
  }): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ principal: table.principal, count: count() })
      .from(table)
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.agentFolder, input.agentFolder),
          eq(table.kind, HUMAN_DECISION_MEMORY_KIND),
          eq(table.actingPersonId, input.actingPersonId),
          eq(table.outcome, HumanDecisionOutcome.Allow),
          eq(table.scope, HumanDecisionScope.Exact),
          eq(table.railVersion, input.railVersion),
          isNull(table.revokedAt),
          isNotNull(table.principal),
        ),
      )
      .groupBy(table.principal);
    return Object.fromEntries(
      rows.flatMap((row) =>
        row.principal ? [[row.principal, row.count] as const] : [],
      ),
    );
  }

  async putClassifierVerdict(input: {
    appId: string;
    agentFolder: string;
    effectHash: string;
    decision: 'allow' | 'ask';
    reason: string;
    risk_level: NonNullable<PermissionDecisionMemoryPutInput['risk_level']>;
    risk_category?: PermissionDecisionMemoryPutInput['risk_category'];
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
      risk_level: input.risk_level,
      risk_category: input.risk_category,
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
    if (
      !row ||
      (row.decision !== 'allow' && row.decision !== 'ask') ||
      !row.risk_level
    ) {
      return null;
    }
    return {
      decision: row.decision,
      reason: row.reason,
      risk_level: row.risk_level,
      ...(row.risk_category ? { risk_category: row.risk_category } : {}),
    };
  }

  async get(input: {
    appId: string;
    agentFolder: string;
    kind: PermissionDecisionMemoryKind;
    lookupIdentity: string;
  }): Promise<PermissionDecisionMemoryRow | null> {
    assertNonHumanKind(input.kind);
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
          or(isNull(table.expiresAt), gt(table.expiresAt, sql`now()`)),
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
    assertNonHumanKind(input.kind);
    const rows = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.agentFolder, input.agentFolder),
          isNull(table.revokedAt),
          or(isNull(table.expiresAt), gt(table.expiresAt, sql`now()`)),
          input.kind
            ? eq(table.kind, input.kind)
            : ne(table.kind, HUMAN_DECISION_MEMORY_KIND),
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
    assertNonHumanKind(input.kind);
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
    outcome: (row.outcome ?? undefined) as
      | PermissionDecisionMemoryRow['outcome']
      | undefined,
    scope: (row.scope ?? undefined) as
      | PermissionDecisionMemoryRow['scope']
      | undefined,
    scopeKey: row.scopeKey ?? undefined,
    actingPersonId: row.actingPersonId ?? undefined,
    actingPersonLabel: row.actingPersonLabel ?? undefined,
    reason: row.reason,
    risk_level: (row.riskLevel ?? undefined) as
      | PermissionDecisionMemoryRow['risk_level']
      | undefined,
    risk_category: (row.riskCategory ?? undefined) as
      | PermissionDecisionMemoryRow['risk_category']
      | undefined,
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
