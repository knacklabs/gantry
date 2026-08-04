import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import { PostgresInteractionRepositoryMethods } from './worker-coordination-interaction-repository.postgres.js';
import { claimRunLeaseInTx, DEFAULT_NONCE_TTL_MS, isoPlusMs, isUniqueViolation, lockRunSlotKey, settleRunLeaseTx, toRunLease, } from './worker-coordination-lease.postgres.js';
function toWorkerInstance(row) {
    return {
        id: row.id,
        imageDigest: row.imageDigest,
        bootNonce: row.bootNonce,
        version: row.version,
        capabilities: Array.isArray(row.capabilitiesJson)
            ? row.capabilitiesJson
            : [],
        processRole: row.processRole,
        status: row.status,
        heartbeatAt: row.heartbeatAt,
        lastSeenAt: row.lastSeenAt,
        createdAt: row.createdAt,
    };
}
export class PostgresWorkerCoordinationRepository extends PostgresInteractionRepositoryMethods {
    constructor(db, commandNotifier) {
        super(db, commandNotifier);
    }
    async registerWorker(input) {
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
    async heartbeatWorker(input) {
        const now = input.now ?? currentIso();
        const rows = await this.db
            .update(pgSchema.workerInstancesPostgres)
            .set({ status: 'healthy', heartbeatAt: now, lastSeenAt: now })
            .where(and(eq(pgSchema.workerInstancesPostgres.id, input.id), inArray(pgSchema.workerInstancesPostgres.status, [
            'starting',
            'healthy',
            'unhealthy',
        ])))
            .returning({ id: pgSchema.workerInstancesPostgres.id });
        return rows.length > 0;
    }
    async advertiseWorkerCapabilities(input) {
        const now = input.now ?? currentIso();
        const capabilities = [...new Set(input.capabilities)].sort();
        const rows = await this.db
            .update(pgSchema.workerInstancesPostgres)
            .set({ capabilitiesJson: capabilities, lastSeenAt: now })
            .where(eq(pgSchema.workerInstancesPostgres.id, input.id))
            .returning({ id: pgSchema.workerInstancesPostgres.id });
        return rows.length > 0;
    }
    async markStaleWorkersUnhealthy(input) {
        const rows = await this.db
            .update(pgSchema.workerInstancesPostgres)
            .set({ status: 'unhealthy' })
            .where(and(inArray(pgSchema.workerInstancesPostgres.status, [
            'starting',
            'healthy',
        ]), lt(pgSchema.workerInstancesPostgres.heartbeatAt, input.staleBefore)))
            .returning({ id: pgSchema.workerInstancesPostgres.id });
        return rows.map((row) => row.id);
    }
    async listActiveWorkerCapabilities(input) {
        const rows = await this.db
            .select({
            capabilitiesJson: pgSchema.workerInstancesPostgres.capabilitiesJson,
        })
            .from(pgSchema.workerInstancesPostgres)
            .where(and(inArray(pgSchema.workerInstancesPostgres.status, [
            'starting',
            'healthy',
        ]), sql `${pgSchema.workerInstancesPostgres.heartbeatAt} > ${input.staleBefore}`));
        return rows.map((row) => Array.isArray(row.capabilitiesJson)
            ? row.capabilitiesJson
            : []);
    }
    async getWorker(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.workerInstancesPostgres)
            .where(eq(pgSchema.workerInstancesPostgres.id, id))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        return toWorkerInstance(row);
    }
    async listWorkers() {
        const rows = await this.db
            .select()
            .from(pgSchema.workerInstancesPostgres)
            .orderBy(sql `${pgSchema.workerInstancesPostgres.heartbeatAt} DESC`);
        return rows.map(toWorkerInstance);
    }
    async claimRunLease(input) {
        try {
            return await this.db.transaction((tx) => claimRunLeaseInTx(tx, input));
        }
        catch (err) {
            // Partial unique indexes back-stop concurrent claims.
            if (isUniqueViolation(err))
                return null;
            throw err;
        }
    }
    async heartbeatRunLease(input) {
        const now = input.now ?? currentIso();
        const rows = await this.db
            .update(pgSchema.runLeasesPostgres)
            .set({ heartbeatAt: now, expiresAt: isoPlusMs(now, input.ttlMs) })
            .where(and(eq(pgSchema.runLeasesPostgres.runId, input.runId), eq(pgSchema.runLeasesPostgres.leaseToken, input.leaseToken), eq(pgSchema.runLeasesPostgres.status, 'active'), sql `${pgSchema.runLeasesPostgres.expiresAt} > ${now}`))
            .returning({ runId: pgSchema.runLeasesPostgres.runId });
        return rows.length > 0;
    }
    async settleRunLease(input) {
        return settleRunLeaseTx(this.db, input);
    }
    async getActiveRunLease(input) {
        const now = input.now ?? currentIso();
        const rows = await this.db
            .select()
            .from(pgSchema.runLeasesPostgres)
            .where(and(eq(pgSchema.runLeasesPostgres.runId, input.runId), eq(pgSchema.runLeasesPostgres.status, 'active'), sql `${pgSchema.runLeasesPostgres.expiresAt} > ${now}`))
            .limit(1);
        const row = rows[0];
        return row ? toRunLease(row) : null;
    }
    async recoverExpiredRunLeases(input) {
        const now = input.now ?? currentIso();
        const recoverable = input.staleBefore
            ? or(lte(pgSchema.runLeasesPostgres.expiresAt, now), sql `EXISTS (SELECT 1 FROM ${pgSchema.workerInstancesPostgres} wi WHERE wi.id = ${pgSchema.runLeasesPostgres.workerInstanceId} AND (wi.status IN ('unhealthy', 'stopped') OR wi.heartbeat_at < ${input.staleBefore}))`)
            : lte(pgSchema.runLeasesPostgres.expiresAt, now);
        const rows = await this.db
            .update(pgSchema.runLeasesPostgres)
            .set({ status: 'expired' })
            .where(and(eq(pgSchema.runLeasesPostgres.status, 'active'), recoverable))
            .returning({
            runId: pgSchema.runLeasesPostgres.runId,
            jobId: pgSchema.runLeasesPostgres.jobId,
            workerInstanceId: pgSchema.runLeasesPostgres.workerInstanceId,
            fencingVersion: pgSchema.runLeasesPostgres.fencingVersion,
        });
        return rows.map((row) => ({ ...row, expiredAt: now }));
    }
    async acquireRunSlot(input) {
        const now = input.now ?? currentIso();
        const capacity = Math.max(1, Math.floor(input.capacity));
        return this.db.transaction(async (tx) => {
            await lockRunSlotKey(tx, input.slotKey);
            const slots = pgSchema.runSlotsPostgres;
            await tx
                .delete(slots)
                .where(and(eq(slots.slotKey, input.slotKey), lte(slots.expiresAt, now)));
            const held = await tx
                .select({ count: sql `count(*)` })
                .from(slots)
                .where(eq(slots.slotKey, input.slotKey));
            if (Number(held[0]?.count ?? 0) >= capacity)
                return false;
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
    async renewRunSlot(input) {
        const now = input.now ?? currentIso();
        const rows = await this.db
            .update(pgSchema.runSlotsPostgres)
            .set({ expiresAt: isoPlusMs(now, input.ttlMs) })
            .where(and(eq(pgSchema.runSlotsPostgres.slotKey, input.slotKey), eq(pgSchema.runSlotsPostgres.holderId, input.holderId), sql `${pgSchema.runSlotsPostgres.expiresAt} > ${now}`))
            .returning({ holderId: pgSchema.runSlotsPostgres.holderId });
        return rows.length > 0;
    }
    async releaseRunSlot(input) {
        await this.db
            .delete(pgSchema.runSlotsPostgres)
            .where(and(eq(pgSchema.runSlotsPostgres.slotKey, input.slotKey), eq(pgSchema.runSlotsPostgres.holderId, input.holderId)));
    }
    async releaseRunSlotsForStaleWorkers(input) {
        const rows = await this.db
            .delete(pgSchema.runSlotsPostgres)
            .where(sql `${pgSchema.runSlotsPostgres.workerInstanceId} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${pgSchema.workerInstancesPostgres} wi
            WHERE wi.id = ${pgSchema.runSlotsPostgres.workerInstanceId}
              AND (wi.status IN ('unhealthy', 'stopped')
                OR wi.heartbeat_at < ${input.staleBefore})
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${pgSchema.runLeasesPostgres} rl
            WHERE rl.run_id = ${pgSchema.runSlotsPostgres.runId}
              AND rl.worker_instance_id = ${pgSchema.runSlotsPostgres.workerInstanceId}
              AND rl.status = 'active' AND rl.expires_at > ${currentIso()}
          )`)
            .returning({ holderId: pgSchema.runSlotsPostgres.holderId });
        return rows.length;
    }
    async appendRunnerControlEvent(input) {
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
            if (nonceRows.length === 0)
                return 'replayed';
            const leases = pgSchema.runLeasesPostgres;
            const leaseStatusPredicate = input.eventType === 'terminal_state'
                ? inArray(leases.status, ['completed', 'failed', 'released'])
                : and(eq(leases.status, 'active'), sql `${leases.expiresAt} > ${now}`);
            const leaseRows = await tx
                .select()
                .from(leases)
                .where(and(eq(leases.runId, input.runId), eq(leases.leaseToken, input.leaseToken), leaseStatusPredicate))
                .limit(1);
            const lease = leaseRows[0];
            if (!lease)
                return 'fenced';
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
    async listUnexposedRunnerControlEvents(input) {
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
            eventType: row.eventType,
            payload: (row.payloadJson ?? {}),
            nonce: row.nonce,
            createdAt: row.createdAt,
            exposedAt: row.exposedAt,
        }));
    }
    async markRunnerControlEventsExposed(input) {
        if (input.ids.length === 0)
            return;
        const now = input.now ?? currentIso();
        await this.db
            .update(pgSchema.runnerControlEventsPostgres)
            .set({ exposedAt: now })
            .where(inArray(pgSchema.runnerControlEventsPostgres.id, input.ids));
    }
    async pruneRunnerControlNonces(input) {
        const now = input.now ?? currentIso();
        const rows = await this.db
            .delete(pgSchema.runnerControlNoncesPostgres)
            .where(lte(pgSchema.runnerControlNoncesPostgres.expiresAt, now))
            .returning({ nonce: pgSchema.runnerControlNoncesPostgres.nonce });
        return rows.length;
    }
    async createTransientGrant(input) {
        const now = input.now ?? currentIso();
        return this.db.transaction(async (tx) => {
            const lease = await tx
                .select({ leaseToken: pgSchema.runLeasesPostgres.leaseToken })
                .from(pgSchema.runLeasesPostgres)
                .where(and(eq(pgSchema.runLeasesPostgres.runId, input.runId), eq(pgSchema.runLeasesPostgres.leaseToken, input.leaseToken), eq(pgSchema.runLeasesPostgres.status, 'active'), sql `${pgSchema.runLeasesPostgres.expiresAt} > ${now}`))
                .limit(1);
            if (lease.length === 0)
                return false;
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
    async listActiveTransientGrants(input) {
        const now = input.now ?? currentIso();
        const grants = pgSchema.transientGrantsPostgres;
        const leases = pgSchema.runLeasesPostgres;
        const rows = await this.db
            .select({ grant: grants })
            .from(grants)
            .innerJoin(leases, and(eq(leases.runId, grants.runId), eq(leases.leaseToken, grants.leaseToken), eq(leases.status, 'active'), sql `${leases.expiresAt} > ${now}`))
            .where(and(eq(grants.runId, input.runId), sql `${grants.expiresAt} > ${now}`))
            .orderBy(asc(grants.createdAt));
        return rows.map(({ grant }) => ({
            id: grant.id,
            appId: grant.appId,
            runId: grant.runId,
            leaseToken: grant.leaseToken,
            grant: (grant.grantJson ?? {}),
            createdAt: grant.createdAt,
            expiresAt: grant.expiresAt,
        }));
    }
}
