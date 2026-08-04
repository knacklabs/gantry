import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { AllowOnceNeverPersistedError, } from '../../../../domain/ports/permission-decision-memory.js';
import * as pgSchema from '../schema/schema.js';
const table = pgSchema.permissionDecisionMemoryPostgres;
/**
 * Refuse to persist an ephemeral human `allow_once`. Runnable guard on the single
 * write path — allow_once is never written to decision memory (PERM-2 tripwire).
 */
function assertPersistable(input) {
    if (input.sourceMode === 'allow_once' || input.decision === 'allow_once') {
        throw new AllowOnceNeverPersistedError();
    }
}
export class PostgresPermissionDecisionMemoryRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async put(input) {
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
    async putClassifierVerdict(input) {
        await this.put({
            id: input.id ??
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
            sourceMode: input.sourceMode,
        });
    }
    async getClassifierVerdict(input) {
        const row = await this.get({
            appId: input.appId,
            agentFolder: input.agentFolder,
            kind: 'classifier_verdict',
            lookupIdentity: input.effectHash,
        });
        if (!row ||
            (row.decision !== 'allow' && row.decision !== 'ask') ||
            !row.risk_level) {
            return null;
        }
        return {
            decision: row.decision,
            reason: row.reason,
            risk_level: row.risk_level,
            ...(row.risk_category ? { risk_category: row.risk_category } : {}),
        };
    }
    async get(input) {
        const [row] = await this.db
            .select()
            .from(table)
            .where(and(eq(table.appId, input.appId), eq(table.agentFolder, input.agentFolder), eq(table.kind, input.kind), eq(table.lookupIdentity, input.lookupIdentity), isNull(table.revokedAt), or(isNull(table.expiresAt), gt(table.expiresAt, sql `now()`))))
            .limit(1);
        return row ? mapRow(row) : null;
    }
    async list(input) {
        const rows = await this.db
            .select()
            .from(table)
            .where(and(eq(table.appId, input.appId), eq(table.agentFolder, input.agentFolder), isNull(table.revokedAt), or(isNull(table.expiresAt), gt(table.expiresAt, sql `now()`)), input.kind ? eq(table.kind, input.kind) : undefined));
        return rows.map(mapRow);
    }
    async revoke(input) {
        const rows = await this.db
            .update(table)
            .set({ revokedAt: input.nowIso })
            .where(and(eq(table.appId, input.appId), eq(table.agentFolder, input.agentFolder), eq(table.kind, input.kind), eq(table.lookupIdentity, input.lookupIdentity), isNull(table.revokedAt)))
            .returning({ id: table.id });
        return rows.length === 1;
    }
}
/**
 * Row → domain hydration. Postgres returns NULL for the optional columns; coerce
 * NULL → undefined so downstream `=== undefined` checks work (CAP-1 lesson).
 */
function mapRow(row) {
    return {
        id: row.id,
        appId: row.appId,
        agentFolder: row.agentFolder,
        kind: row.kind,
        lookupIdentity: row.lookupIdentity,
        effectHash: row.effectHash ?? undefined,
        decision: (row.decision ?? undefined),
        reason: row.reason,
        risk_level: (row.riskLevel ?? undefined),
        risk_category: (row.riskCategory ?? undefined),
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
function toIsoTimestamp(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
