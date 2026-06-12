import { and, asc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';

import type {
  PendingInteraction,
  PendingInteractionKind,
  PendingInteractionStatus,
  RecoveredRunLease,
  RunLease,
  RunnerControlEvent,
  RunnerControlEventAppendResult,
  RunnerControlEventType,
  TransientGrant,
  WorkerCoordinationRepository,
  WorkerInstance,
  WorkerInstanceStatus,
} from '../../../../domain/ports/worker-coordination.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import {
  claimRunLeaseInTx,
  DEFAULT_NONCE_TTL_MS,
  isRunLeaseClaimConflict,
  isoPlusMs,
  isUniqueViolation,
  lockRunSlotKey,
  settleRunLeaseTx,
  toRunLease,
} from './worker-coordination-lease.postgres.js';

function toPendingInteraction(
  row: typeof pgSchema.pendingInteractionsPostgres.$inferSelect,
): PendingInteraction {
  return {
    id: row.id,
    appId: row.appId,
    runId: row.runId,
    kind: row.kind as PendingInteractionKind,
    status: row.status as PendingInteractionStatus,
    payload: (row.payloadJson ?? {}) as Record<string, unknown>,
    callbackRoute: (row.callbackRouteJson ?? null) as Record<
      string,
      unknown
    > | null,
    idempotencyKey: row.idempotencyKey,
    approverRef: row.approverRef,
    resolution: (row.resolutionJson ?? null) as Record<string, unknown> | null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
  };
}

function toWorkerInstance(
  row: typeof pgSchema.workerInstancesPostgres.$inferSelect,
): WorkerInstance {
  return {
    id: row.id,
    imageDigest: row.imageDigest,
    bootNonce: row.bootNonce,
    version: row.version,
    capabilities: Array.isArray(row.capabilitiesJson)
      ? (row.capabilitiesJson as string[])
      : [],
    processRole: row.processRole,
    status: row.status as WorkerInstanceStatus,
    heartbeatAt: row.heartbeatAt,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

export class PostgresWorkerCoordinationRepository implements WorkerCoordinationRepository {
  constructor(private readonly db: CanonicalDb) {}

  async registerWorker(input: {
    id: string;
    bootNonce: string;
    imageDigest?: string | null;
    version?: string | null;
    capabilities?: string[];
    processRole?: string;
    now?: string;
  }): Promise<void> {
    const now = input.now ?? currentIso();
    const processRole = input.processRole ?? 'all';
    await this.db
      .insert(pgSchema.workerInstancesPostgres)
      .values({
        id: input.id,
        bootNonce: input.bootNonce,
        imageDigest: input.imageDigest ?? null,
        version: input.version ?? null,
        capabilitiesJson: input.capabilities ?? [],
        processRole,
        status: 'healthy',
        heartbeatAt: now,
        lastSeenAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: pgSchema.workerInstancesPostgres.id,
        set: {
          bootNonce: input.bootNonce,
          imageDigest: input.imageDigest ?? null,
          version: input.version ?? null,
          capabilitiesJson: input.capabilities ?? [],
          processRole,
          status: 'healthy',
          heartbeatAt: now,
          lastSeenAt: now,
        },
      });
  }

  async heartbeatWorker(input: { id: string; now?: string }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const rows = await this.db
      .update(pgSchema.workerInstancesPostgres)
      .set({ status: 'healthy', heartbeatAt: now, lastSeenAt: now })
      .where(
        and(
          eq(pgSchema.workerInstancesPostgres.id, input.id),
          inArray(pgSchema.workerInstancesPostgres.status, [
            'starting',
            'healthy',
            'unhealthy',
          ]),
        ),
      )
      .returning({ id: pgSchema.workerInstancesPostgres.id });
    return rows.length > 0;
  }

  async advertiseWorkerCapabilities(input: {
    id: string;
    capabilities: string[];
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const capabilities = [...new Set(input.capabilities)].sort();
    const rows = await this.db
      .update(pgSchema.workerInstancesPostgres)
      .set({ capabilitiesJson: capabilities, lastSeenAt: now })
      .where(eq(pgSchema.workerInstancesPostgres.id, input.id))
      .returning({ id: pgSchema.workerInstancesPostgres.id });
    return rows.length > 0;
  }

  async markStaleWorkersUnhealthy(input: {
    staleBefore: string;
  }): Promise<string[]> {
    const rows = await this.db
      .update(pgSchema.workerInstancesPostgres)
      .set({ status: 'unhealthy' })
      .where(
        and(
          inArray(pgSchema.workerInstancesPostgres.status, [
            'starting',
            'healthy',
          ]),
          lt(pgSchema.workerInstancesPostgres.heartbeatAt, input.staleBefore),
        ),
      )
      .returning({ id: pgSchema.workerInstancesPostgres.id });
    return rows.map((row) => row.id);
  }

  async listActiveWorkerCapabilities(input: {
    staleBefore: string;
  }): Promise<string[][]> {
    const rows = await this.db
      .select({
        capabilitiesJson: pgSchema.workerInstancesPostgres.capabilitiesJson,
      })
      .from(pgSchema.workerInstancesPostgres)
      .where(
        and(
          inArray(pgSchema.workerInstancesPostgres.status, [
            'starting',
            'healthy',
          ]),
          sql`${pgSchema.workerInstancesPostgres.heartbeatAt} > ${input.staleBefore}`,
        ),
      );
    return rows.map((row) =>
      Array.isArray(row.capabilitiesJson)
        ? (row.capabilitiesJson as string[])
        : [],
    );
  }

  async getWorker(id: string): Promise<WorkerInstance | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.workerInstancesPostgres)
      .where(eq(pgSchema.workerInstancesPostgres.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toWorkerInstance(row);
  }

  async listWorkers(): Promise<WorkerInstance[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.workerInstancesPostgres)
      .orderBy(sql`${pgSchema.workerInstancesPostgres.heartbeatAt} DESC`);
    return rows.map(toWorkerInstance);
  }

  async claimRunLease(input: {
    runId: string;
    jobId?: string | null;
    workerInstanceId: string;
    ttlMs: number;
    now?: string;
  }): Promise<RunLease | null> {
    try {
      return await this.db.transaction((tx) => claimRunLeaseInTx(tx, input));
    } catch (err) {
      // Partial unique indexes on (run_id) / (job_id) where status='active'
      // back-stop concurrent claims: the loser sees a unique violation.
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async heartbeatRunLease(input: {
    runId: string;
    leaseToken: string;
    ttlMs: number;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const rows = await this.db
      .update(pgSchema.runLeasesPostgres)
      .set({ heartbeatAt: now, expiresAt: isoPlusMs(now, input.ttlMs) })
      .where(
        and(
          eq(pgSchema.runLeasesPostgres.runId, input.runId),
          eq(pgSchema.runLeasesPostgres.leaseToken, input.leaseToken),
          eq(pgSchema.runLeasesPostgres.status, 'active'),
          sql`${pgSchema.runLeasesPostgres.expiresAt} > ${now}`,
        ),
      )
      .returning({ runId: pgSchema.runLeasesPostgres.runId });
    return rows.length > 0;
  }

  async settleRunLease(input: {
    runId: string;
    leaseToken: string;
    outcome: 'completed' | 'failed' | 'released';
    now?: string;
    allowAlreadySettled?: boolean;
  }): Promise<boolean> {
    return settleRunLeaseTx(this.db, input);
  }

  async getActiveRunLease(input: {
    runId: string;
    now?: string;
  }): Promise<RunLease | null> {
    const now = input.now ?? currentIso();
    const rows = await this.db
      .select()
      .from(pgSchema.runLeasesPostgres)
      .where(
        and(
          eq(pgSchema.runLeasesPostgres.runId, input.runId),
          eq(pgSchema.runLeasesPostgres.status, 'active'),
          sql`${pgSchema.runLeasesPostgres.expiresAt} > ${now}`,
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toRunLease(row) : null;
  }

  async recoverExpiredRunLeases(input: {
    now?: string;
  }): Promise<RecoveredRunLease[]> {
    const now = input.now ?? currentIso();
    const rows = await this.db
      .update(pgSchema.runLeasesPostgres)
      .set({ status: 'expired' })
      .where(
        and(
          eq(pgSchema.runLeasesPostgres.status, 'active'),
          lte(pgSchema.runLeasesPostgres.expiresAt, now),
        ),
      )
      .returning({
        runId: pgSchema.runLeasesPostgres.runId,
        jobId: pgSchema.runLeasesPostgres.jobId,
        workerInstanceId: pgSchema.runLeasesPostgres.workerInstanceId,
        fencingVersion: pgSchema.runLeasesPostgres.fencingVersion,
      });
    return rows.map((row) => ({ ...row, expiredAt: now }));
  }

  async acquireRunSlot(input: {
    slotKey: string;
    holderId: string;
    capacity: number;
    ttlMs: number;
    runId?: string | null;
    workerInstanceId?: string | null;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const capacity = Math.max(1, Math.floor(input.capacity));
    return this.db.transaction(async (tx) => {
      await lockRunSlotKey(tx, input.slotKey);
      const slots = pgSchema.runSlotsPostgres;
      await tx
        .delete(slots)
        .where(
          and(eq(slots.slotKey, input.slotKey), lte(slots.expiresAt, now)),
        );
      const held = await tx
        .select({ count: sql<number>`count(*)` })
        .from(slots)
        .where(eq(slots.slotKey, input.slotKey));
      if (Number(held[0]?.count ?? 0) >= capacity) return false;
      await tx
        .insert(slots)
        .values({
          slotKey: input.slotKey,
          holderId: input.holderId,
          runId: input.runId ?? null,
          workerInstanceId: input.workerInstanceId ?? null,
          acquiredAt: now,
          expiresAt: isoPlusMs(now, input.ttlMs),
        })
        .onConflictDoUpdate({
          target: [slots.slotKey, slots.holderId],
          set: { expiresAt: isoPlusMs(now, input.ttlMs) },
        });
      return true;
    });
  }

  async renewRunSlot(input: {
    slotKey: string;
    holderId: string;
    ttlMs: number;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const rows = await this.db
      .update(pgSchema.runSlotsPostgres)
      .set({ expiresAt: isoPlusMs(now, input.ttlMs) })
      .where(
        and(
          eq(pgSchema.runSlotsPostgres.slotKey, input.slotKey),
          eq(pgSchema.runSlotsPostgres.holderId, input.holderId),
          sql`${pgSchema.runSlotsPostgres.expiresAt} > ${now}`,
        ),
      )
      .returning({ holderId: pgSchema.runSlotsPostgres.holderId });
    return rows.length > 0;
  }

  async releaseRunSlot(input: {
    slotKey: string;
    holderId: string;
  }): Promise<void> {
    await this.db
      .delete(pgSchema.runSlotsPostgres)
      .where(
        and(
          eq(pgSchema.runSlotsPostgres.slotKey, input.slotKey),
          eq(pgSchema.runSlotsPostgres.holderId, input.holderId),
        ),
      );
  }

  async appendRunnerControlEvent(input: {
    id: string;
    runId: string;
    jobId?: string | null;
    leaseToken: string;
    eventType: RunnerControlEventType;
    payload?: Record<string, unknown>;
    nonce: string;
    nonceTtlMs?: number;
    now?: string;
  }): Promise<RunnerControlEventAppendResult> {
    const now = input.now ?? currentIso();
    return this.db.transaction(async (tx) => {
      const nonceRows = await tx
        .insert(pgSchema.runnerControlNoncesPostgres)
        .values({
          nonce: input.nonce,
          runId: input.runId,
          expiresAt: isoPlusMs(now, input.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS),
        })
        .onConflictDoNothing()
        .returning({ nonce: pgSchema.runnerControlNoncesPostgres.nonce });
      if (nonceRows.length === 0) return 'replayed';
      const leases = pgSchema.runLeasesPostgres;
      const leaseStatusPredicate =
        input.eventType === 'terminal_state'
          ? inArray(leases.status, ['completed', 'failed', 'released'])
          : and(eq(leases.status, 'active'), sql`${leases.expiresAt} > ${now}`);
      const leaseRows = await tx
        .select()
        .from(leases)
        .where(
          and(
            eq(leases.runId, input.runId),
            eq(leases.leaseToken, input.leaseToken),
            leaseStatusPredicate,
          ),
        )
        .limit(1);
      const lease = leaseRows[0];
      if (!lease) return 'fenced';
      await tx.insert(pgSchema.runnerControlEventsPostgres).values({
        id: input.id,
        runId: input.runId,
        jobId: input.jobId ?? lease.jobId,
        workerInstanceId: lease.workerInstanceId,
        fencingVersion: lease.fencingVersion,
        eventType: input.eventType,
        payloadJson: input.payload ?? {},
        nonce: input.nonce,
        createdAt: now,
        exposedAt: null,
      });
      return 'persisted';
    });
  }

  async listUnexposedRunnerControlEvents(input: {
    limit: number;
  }): Promise<RunnerControlEvent[]> {
    const events = pgSchema.runnerControlEventsPostgres;
    const rows = await this.db
      .select()
      .from(events)
      .where(isNull(events.exposedAt))
      .orderBy(asc(events.createdAt))
      .limit(Math.max(1, Math.floor(input.limit)));
    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      jobId: row.jobId,
      workerInstanceId: row.workerInstanceId,
      fencingVersion: row.fencingVersion,
      eventType: row.eventType as RunnerControlEventType,
      payload: (row.payloadJson ?? {}) as Record<string, unknown>,
      nonce: row.nonce,
      createdAt: row.createdAt,
      exposedAt: row.exposedAt,
    }));
  }

  async markRunnerControlEventsExposed(input: {
    ids: string[];
    now?: string;
  }): Promise<void> {
    if (input.ids.length === 0) return;
    const now = input.now ?? currentIso();
    await this.db
      .update(pgSchema.runnerControlEventsPostgres)
      .set({ exposedAt: now })
      .where(inArray(pgSchema.runnerControlEventsPostgres.id, input.ids));
  }

  async pruneRunnerControlNonces(input: { now?: string }): Promise<number> {
    const now = input.now ?? currentIso();
    const rows = await this.db
      .delete(pgSchema.runnerControlNoncesPostgres)
      .where(lte(pgSchema.runnerControlNoncesPostgres.expiresAt, now))
      .returning({ nonce: pgSchema.runnerControlNoncesPostgres.nonce });
    return rows.length;
  }

  async createPendingInteraction(input: {
    id: string;
    appId: string;
    runId?: string | null;
    kind: PendingInteractionKind;
    payload: Record<string, unknown>;
    callbackRoute?: Record<string, unknown> | null;
    idempotencyKey: string;
    expiresAt: string;
    now?: string;
  }): Promise<PendingInteraction> {
    const now = input.now ?? currentIso();
    try {
      const rows = await this.db
        .insert(pgSchema.pendingInteractionsPostgres)
        .values({
          id: input.id,
          appId: input.appId,
          runId: input.runId ?? null,
          kind: input.kind,
          status: 'pending',
          payloadJson: input.payload,
          callbackRouteJson: input.callbackRoute ?? null,
          idempotencyKey: input.idempotencyKey,
          approverRef: null,
          resolutionJson: null,
          createdAt: now,
          expiresAt: input.expiresAt,
          resolvedAt: null,
        })
        .returning();
      return toPendingInteraction(rows[0]!);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A re-prompt after a provider/adapter restart reuses this record by
      // idempotency key. The callback route is durable routing authority for the
      // owning live turn; a re-prompt that omits it (restarted adapter) must NOT
      // erase the original route or interaction resolution can no longer reach
      // the (possibly recovered) owner. COALESCE preserves the existing route.
      const refreshed = await this.db
        .update(pgSchema.pendingInteractionsPostgres)
        .set({
          payloadJson: input.payload,
          callbackRouteJson:
            input.callbackRoute ??
            sql`${pgSchema.pendingInteractionsPostgres.callbackRouteJson}`,
          expiresAt: input.expiresAt,
        })
        .where(
          and(
            eq(
              pgSchema.pendingInteractionsPostgres.idempotencyKey,
              input.idempotencyKey,
            ),
            eq(pgSchema.pendingInteractionsPostgres.status, 'pending'),
          ),
        )
        .returning();
      if (refreshed[0]) return toPendingInteraction(refreshed[0]);
      const existing = await this.db
        .select()
        .from(pgSchema.pendingInteractionsPostgres)
        .where(
          eq(
            pgSchema.pendingInteractionsPostgres.idempotencyKey,
            input.idempotencyKey,
          ),
        )
        .limit(1);
      return toPendingInteraction(existing[0]!);
    }
  }

  async resolvePendingInteraction(input: {
    idempotencyKey: string;
    status: 'resolved' | 'cancelled';
    resolution: Record<string, unknown>;
    approverRef?: string | null;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const rows = await this.db
      .update(pgSchema.pendingInteractionsPostgres)
      .set({
        status: input.status,
        resolutionJson: input.resolution,
        approverRef: input.approverRef ?? null,
        resolvedAt: now,
      })
      .where(
        and(
          eq(
            pgSchema.pendingInteractionsPostgres.idempotencyKey,
            input.idempotencyKey,
          ),
          eq(pgSchema.pendingInteractionsPostgres.status, 'pending'),
        ),
      )
      .returning({ id: pgSchema.pendingInteractionsPostgres.id });
    return rows.length > 0;
  }

  async updatePendingInteractionPayload(input: {
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    const rows = await this.db
      .update(pgSchema.pendingInteractionsPostgres)
      .set({ payloadJson: input.payload })
      .where(
        and(
          eq(
            pgSchema.pendingInteractionsPostgres.idempotencyKey,
            input.idempotencyKey,
          ),
          eq(pgSchema.pendingInteractionsPostgres.status, 'pending'),
        ),
      )
      .returning({ id: pgSchema.pendingInteractionsPostgres.id });
    return rows.length > 0;
  }

  async listPendingInteractions(input: {
    appId: string;
    runId?: string | null;
    now?: string;
  }): Promise<PendingInteraction[]> {
    const now = input.now ?? currentIso();
    const table = pgSchema.pendingInteractionsPostgres;
    const rows = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.status, 'pending'),
          sql`${table.expiresAt} > ${now}`,
          input.runId ? eq(table.runId, input.runId) : undefined,
        ),
      )
      .orderBy(asc(table.createdAt));
    return rows.map(toPendingInteraction);
  }

  async createTransientGrant(input: {
    id: string;
    appId: string;
    runId: string;
    leaseToken: string;
    grant: Record<string, unknown>;
    expiresAt: string;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    return this.db.transaction(async (tx) => {
      const lease = await tx
        .select({ leaseToken: pgSchema.runLeasesPostgres.leaseToken })
        .from(pgSchema.runLeasesPostgres)
        .where(
          and(
            eq(pgSchema.runLeasesPostgres.runId, input.runId),
            eq(pgSchema.runLeasesPostgres.leaseToken, input.leaseToken),
            eq(pgSchema.runLeasesPostgres.status, 'active'),
            sql`${pgSchema.runLeasesPostgres.expiresAt} > ${now}`,
          ),
        )
        .limit(1);
      if (lease.length === 0) return false;
      await tx.insert(pgSchema.transientGrantsPostgres).values({
        id: input.id,
        appId: input.appId,
        runId: input.runId,
        leaseToken: input.leaseToken,
        grantJson: input.grant,
        createdAt: now,
        expiresAt: input.expiresAt,
      });
      return true;
    });
  }

  async listActiveTransientGrants(input: {
    runId: string;
    now?: string;
  }): Promise<TransientGrant[]> {
    const now = input.now ?? currentIso();
    const grants = pgSchema.transientGrantsPostgres;
    const leases = pgSchema.runLeasesPostgres;
    const rows = await this.db
      .select({ grant: grants })
      .from(grants)
      .innerJoin(
        leases,
        and(
          eq(leases.runId, grants.runId),
          eq(leases.leaseToken, grants.leaseToken),
          eq(leases.status, 'active'),
          sql`${leases.expiresAt} > ${now}`,
        ),
      )
      .where(
        and(eq(grants.runId, input.runId), sql`${grants.expiresAt} > ${now}`),
      )
      .orderBy(asc(grants.createdAt));
    return rows.map(({ grant }) => ({
      id: grant.id,
      appId: grant.appId,
      runId: grant.runId,
      leaseToken: grant.leaseToken,
      grant: (grant.grantJson ?? {}) as Record<string, unknown>,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
    }));
  }
}
