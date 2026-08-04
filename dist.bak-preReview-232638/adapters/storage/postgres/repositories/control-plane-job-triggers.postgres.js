import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import { mapTrigger, } from '../schema/control-plane-canonical.postgres.js';
import * as pgSchema from '../schema/schema.js';
export class PostgresJobTriggerRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async create(input) {
        const job = await this.db
            .select({ appId: pgSchema.canonicalJobsPostgres.appId })
            .from(pgSchema.canonicalJobsPostgres)
            .where(eq(pgSchema.canonicalJobsPostgres.id, input.jobId))
            .limit(1);
        const appId = job[0]?.appId ?? 'default';
        const now = currentIso();
        const rows = await this.db
            .insert(pgSchema.canonicalJobTriggersPostgres)
            .values({
            id: randomUUID(),
            appId,
            jobId: input.jobId,
            runId: null,
            requestedBy: input.requestedBy ?? 'sdk',
            requestedAt: now,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
        })
            .returning();
        return mapTrigger(rows[0]);
    }
    async bindPendingToRun(jobId, runId) {
        return this.db.transaction(async (tx) => {
            const [pending] = await tx
                .select()
                .from(pgSchema.canonicalJobTriggersPostgres)
                .where(and(eq(pgSchema.canonicalJobTriggersPostgres.jobId, jobId), eq(pgSchema.canonicalJobTriggersPostgres.status, 'pending')))
                .orderBy(asc(pgSchema.canonicalJobTriggersPostgres.requestedAt), asc(pgSchema.canonicalJobTriggersPostgres.id))
                .limit(1)
                .for('update', { skipLocked: true });
            if (!pending)
                return undefined;
            const rows = await tx
                .update(pgSchema.canonicalJobTriggersPostgres)
                .set({
                runId,
                status: 'claimed',
                updatedAt: currentIso(),
            })
                .where(and(eq(pgSchema.canonicalJobTriggersPostgres.id, pending.id), eq(pgSchema.canonicalJobTriggersPostgres.status, 'pending')))
                .returning();
            return rows[0] ? mapTrigger(rows[0]) : undefined;
        });
    }
    async bindToRun(triggerId, runId) {
        const rows = await this.db
            .update(pgSchema.canonicalJobTriggersPostgres)
            .set({
            runId,
            status: 'claimed',
            updatedAt: currentIso(),
        })
            .where(and(eq(pgSchema.canonicalJobTriggersPostgres.id, triggerId), eq(pgSchema.canonicalJobTriggersPostgres.status, 'pending')))
            .returning();
        return rows[0] ? mapTrigger(rows[0]) : undefined;
    }
    async markCompleted(triggerId, status) {
        await this.db
            .update(pgSchema.canonicalJobTriggersPostgres)
            .set({ status, updatedAt: currentIso() })
            .where(eq(pgSchema.canonicalJobTriggersPostgres.id, triggerId));
    }
    async getById(triggerId) {
        const rows = await this.db
            .select()
            .from(pgSchema.canonicalJobTriggersPostgres)
            .where(eq(pgSchema.canonicalJobTriggersPostgres.id, triggerId))
            .limit(1);
        return rows[0] ? mapTrigger(rows[0]) : undefined;
    }
}
