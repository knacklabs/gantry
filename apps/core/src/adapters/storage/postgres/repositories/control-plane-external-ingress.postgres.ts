import { randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';

import { nowIso as currentIso } from '../../../../infrastructure/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { ensureControlGraph } from './control-plane-graph.postgres.js';

const EXTERNAL_INGRESS_SWEEP_BATCH_SIZE = 1000;
const EXTERNAL_INGRESS_SWEEP_MAX_DELETE_BATCHES = 10;

export class PostgresExternalIngressRepository {
  constructor(private readonly db: CanonicalDb) {}

  async create(input: {
    ingressId?: string;
    appId: string;
    name: string;
    secret: string;
    enabled?: boolean;
    metadata?: unknown;
  }) {
    await ensureControlGraph(this.db, {
      appId: input.appId,
      externalConversationId: 'external-ingress',
      externalConversationRef: 'external-ingress',
      agentFolder: 'control',
    });
    const now = currentIso();
    const rows = await this.db
      .insert(pgSchema.externalIngressesPostgres)
      .values({
        ingressId: input.ingressId ?? randomUUID(),
        appId: input.appId,
        name: input.name,
        secret: input.secret,
        enabled: input.enabled ?? true,
        metadataJson: JSON.stringify(input.metadata ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return mapExternalIngress(rows[0]!);
  }

  async list(appId: string) {
    const rows = await this.db
      .select()
      .from(pgSchema.externalIngressesPostgres)
      .where(eq(pgSchema.externalIngressesPostgres.appId, appId))
      .orderBy(desc(pgSchema.externalIngressesPostgres.updatedAt));
    return rows.map(mapExternalIngress);
  }

  async getById(ingressId: string, appId?: string) {
    const conditions = [
      eq(pgSchema.externalIngressesPostgres.ingressId, ingressId),
    ];
    if (appId)
      conditions.push(eq(pgSchema.externalIngressesPostgres.appId, appId));
    const rows = await this.db
      .select()
      .from(pgSchema.externalIngressesPostgres)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? mapExternalIngress(rows[0]) : undefined;
  }

  async update(
    ingressId: string,
    appId: string,
    patch: {
      name?: string;
      secret?: string;
      enabled?: boolean;
      metadata?: unknown;
    },
  ) {
    const existing = await this.getById(ingressId, appId);
    if (!existing) return undefined;
    const rows = await this.db
      .update(pgSchema.externalIngressesPostgres)
      .set({
        name: patch.name ?? existing.name,
        secret: patch.secret ?? existing.secret,
        enabled: patch.enabled ?? existing.enabled,
        metadataJson:
          patch.metadata !== undefined
            ? JSON.stringify(patch.metadata)
            : JSON.stringify(existing.metadata),
        updatedAt: currentIso(),
      })
      .where(
        and(
          eq(pgSchema.externalIngressesPostgres.ingressId, ingressId),
          eq(pgSchema.externalIngressesPostgres.appId, appId),
        ),
      )
      .returning();
    return rows[0] ? mapExternalIngress(rows[0]) : undefined;
  }

  async delete(ingressId: string, appId: string): Promise<boolean> {
    const result = await this.db
      .delete(pgSchema.externalIngressesPostgres)
      .where(
        and(
          eq(pgSchema.externalIngressesPostgres.ingressId, ingressId),
          eq(pgSchema.externalIngressesPostgres.appId, appId),
        ),
      );
    return Number(result.rowCount ?? 0) > 0;
  }

  async reserveNonce(input: {
    appId: string;
    ingressId: string;
    nonce: string;
    now: string;
    expiresAt: string;
  }): Promise<{ ok: true } | { ok: false; code: 'NONCE_REPLAY' }> {
    const rows = await this.db
      .insert(pgSchema.externalIngressNoncesPostgres)
      .values({
        appId: input.appId,
        ingressId: input.ingressId,
        nonce: input.nonce,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing()
      .returning({
        nonce: pgSchema.externalIngressNoncesPostgres.nonce,
      });
    return rows[0] ? { ok: true } : { ok: false, code: 'NONCE_REPLAY' };
  }

  async createInvocation(input: {
    invocationId: string;
    appId: string;
    ingressId: string;
    idempotencyKey: string;
    nonce: string;
    requestMethod: string;
    requestPath: string;
    requestTimestamp: string;
    bodyHash: string;
    requestBody: string;
    signature: string;
    status: string;
    now: string;
    expiresAt: string;
  }) {
    const rows = await this.db
      .insert(pgSchema.externalIngressInvocationsPostgres)
      .values({
        invocationId: input.invocationId,
        appId: input.appId,
        ingressId: input.ingressId,
        idempotencyKey: input.idempotencyKey,
        nonce: input.nonce,
        requestMethod: input.requestMethod,
        requestPath: input.requestPath,
        requestTimestamp: input.requestTimestamp,
        bodyHash: input.bodyHash,
        requestBody: input.requestBody,
        signature: input.signature,
        status: input.status,
        createdAt: input.now,
        updatedAt: input.now,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing()
      .returning({
        invocationId: pgSchema.externalIngressInvocationsPostgres.invocationId,
        status: pgSchema.externalIngressInvocationsPostgres.status,
        bodyHash: pgSchema.externalIngressInvocationsPostgres.bodyHash,
        responseJson: pgSchema.externalIngressInvocationsPostgres.responseJson,
        error: pgSchema.externalIngressInvocationsPostgres.error,
        updatedAt: pgSchema.externalIngressInvocationsPostgres.updatedAt,
      });
    if (rows[0]) {
      return { created: true as const, row: mapInvocationRow(rows[0]) };
    }
    const existing = await this.getInvocationByIdempotencyKey({
      appId: input.appId,
      ingressId: input.ingressId,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) return { created: false as const, row: existing };
    const retried = await this.db
      .insert(pgSchema.externalIngressInvocationsPostgres)
      .values({
        invocationId: input.invocationId,
        appId: input.appId,
        ingressId: input.ingressId,
        idempotencyKey: input.idempotencyKey,
        nonce: input.nonce,
        requestMethod: input.requestMethod,
        requestPath: input.requestPath,
        requestTimestamp: input.requestTimestamp,
        bodyHash: input.bodyHash,
        requestBody: input.requestBody,
        signature: input.signature,
        status: input.status,
        createdAt: input.now,
        updatedAt: input.now,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing()
      .returning({
        invocationId: pgSchema.externalIngressInvocationsPostgres.invocationId,
        status: pgSchema.externalIngressInvocationsPostgres.status,
        bodyHash: pgSchema.externalIngressInvocationsPostgres.bodyHash,
        responseJson: pgSchema.externalIngressInvocationsPostgres.responseJson,
        error: pgSchema.externalIngressInvocationsPostgres.error,
        updatedAt: pgSchema.externalIngressInvocationsPostgres.updatedAt,
      });
    return {
      created: !!retried[0],
      row: retried[0] ? mapInvocationRow(retried[0]) : undefined,
    };
  }

  async getInvocationByIdempotencyKey(input: {
    appId: string;
    ingressId: string;
    idempotencyKey: string;
  }) {
    const rows = await this.db
      .select({
        invocationId: pgSchema.externalIngressInvocationsPostgres.invocationId,
        status: pgSchema.externalIngressInvocationsPostgres.status,
        bodyHash: pgSchema.externalIngressInvocationsPostgres.bodyHash,
        responseJson: pgSchema.externalIngressInvocationsPostgres.responseJson,
        error: pgSchema.externalIngressInvocationsPostgres.error,
        updatedAt: pgSchema.externalIngressInvocationsPostgres.updatedAt,
      })
      .from(pgSchema.externalIngressInvocationsPostgres)
      .where(
        and(
          eq(pgSchema.externalIngressInvocationsPostgres.appId, input.appId),
          eq(
            pgSchema.externalIngressInvocationsPostgres.ingressId,
            input.ingressId,
          ),
          eq(
            pgSchema.externalIngressInvocationsPostgres.idempotencyKey,
            input.idempotencyKey,
          ),
        ),
      )
      .limit(1);
    return rows[0] ? mapInvocationRow(rows[0]) : undefined;
  }

  async updateInvocation(input: {
    invocationId: string;
    status: string;
    response?: unknown;
    error?: string | null;
    now: string;
  }): Promise<void> {
    await this.db
      .update(pgSchema.externalIngressInvocationsPostgres)
      .set({
        status: input.status,
        responseJson:
          input.response === undefined
            ? undefined
            : JSON.stringify(input.response),
        error: input.error ?? null,
        updatedAt: input.now,
      })
      .where(
        eq(
          pgSchema.externalIngressInvocationsPostgres.invocationId,
          input.invocationId,
        ),
      );
  }

  async getInvocation(invocationId: string, appId: string, ingressId: string) {
    const rows = await this.db
      .select({
        invocationId: pgSchema.externalIngressInvocationsPostgres.invocationId,
        appId: pgSchema.externalIngressInvocationsPostgres.appId,
        ingressId: pgSchema.externalIngressInvocationsPostgres.ingressId,
        idempotencyKey:
          pgSchema.externalIngressInvocationsPostgres.idempotencyKey,
        status: pgSchema.externalIngressInvocationsPostgres.status,
        bodyHash: pgSchema.externalIngressInvocationsPostgres.bodyHash,
        responseJson: pgSchema.externalIngressInvocationsPostgres.responseJson,
        error: pgSchema.externalIngressInvocationsPostgres.error,
        createdAt: pgSchema.externalIngressInvocationsPostgres.createdAt,
        updatedAt: pgSchema.externalIngressInvocationsPostgres.updatedAt,
      })
      .from(pgSchema.externalIngressInvocationsPostgres)
      .where(
        and(
          eq(
            pgSchema.externalIngressInvocationsPostgres.invocationId,
            invocationId,
          ),
          eq(pgSchema.externalIngressInvocationsPostgres.appId, appId),
          eq(pgSchema.externalIngressInvocationsPostgres.ingressId, ingressId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      invocationId: row.invocationId,
      appId: row.appId,
      ingressId: row.ingressId,
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      bodyHash: row.bodyHash,
      response: parseJson(row.responseJson, null),
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async sweepExpiredState(input: { now: string }): Promise<{
    noncesDeleted: number;
    invocationsDeleted: number;
    stalePendingFailed: number;
  }> {
    const staleBefore = new Date(Date.parse(input.now) - 5 * 60_000);
    const stalePendingResult = await this.db
      .update(pgSchema.externalIngressInvocationsPostgres)
      .set({
        status: 'failed',
        error:
          'Invocation did not reach a terminal state before recovery timeout',
        updatedAt: input.now,
      }).where(sql`
        ctid IN (
          SELECT ctid
          FROM ${pgSchema.externalIngressInvocationsPostgres}
          WHERE ${pgSchema.externalIngressInvocationsPostgres.status} = 'pending'
            AND ${pgSchema.externalIngressInvocationsPostgres.updatedAt} < ${staleBefore.toISOString()}
          LIMIT ${EXTERNAL_INGRESS_SWEEP_BATCH_SIZE}
        )
      `);
    const noncesDeleted = await deleteExpiredInBatches(
      this.db,
      pgSchema.externalIngressNoncesPostgres,
      input.now,
    );
    const invocationsDeleted = await deleteExpiredInBatches(
      this.db,
      pgSchema.externalIngressInvocationsPostgres,
      input.now,
    );
    return {
      noncesDeleted,
      invocationsDeleted,
      stalePendingFailed: Number(stalePendingResult.rowCount ?? 0),
    };
  }
}

function mapExternalIngress(row: {
  ingressId: string;
  appId: string;
  name: string;
  secret: string;
  enabled: boolean;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    ingressId: row.ingressId,
    appId: row.appId,
    name: row.name,
    secret: row.secret,
    enabled: row.enabled,
    metadata: parseJson(row.metadataJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapInvocationRow(row: {
  invocationId: string;
  status: string;
  bodyHash: string;
  responseJson: string | null;
  error: string | null;
  updatedAt: string;
}) {
  return {
    invocationId: row.invocationId,
    status: row.status,
    bodyHash: row.bodyHash,
    response: parseJson(row.responseJson, null),
    error: row.error,
    updatedAt: row.updatedAt,
  };
}

async function deleteExpiredInBatches(
  db: CanonicalDb,
  table:
    | typeof pgSchema.externalIngressNoncesPostgres
    | typeof pgSchema.externalIngressInvocationsPostgres,
  now: string,
): Promise<number> {
  let total = 0;
  for (
    let batch = 0;
    batch < EXTERNAL_INGRESS_SWEEP_MAX_DELETE_BATCHES;
    batch += 1
  ) {
    const result = await db.delete(table).where(sql`
      ctid IN (
        SELECT ctid
        FROM ${table}
        WHERE ${table.expiresAt} < ${now}
        LIMIT ${EXTERNAL_INGRESS_SWEEP_BATCH_SIZE}
      )
    `);
    const deleted = Number(result.rowCount ?? 0);
    total += deleted;
    if (deleted < EXTERNAL_INGRESS_SWEEP_BATCH_SIZE) return total;
  }
  return total;
}
