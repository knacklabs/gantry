import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
const Runs = pgSchema.memoryEmbeddingBackfillRunsPostgres;
export async function createBackfillRun(db, input) {
    await db.insert(Runs).values({
        id: input.id,
        appId: input.appId,
        agentId: input.agentId ?? null,
        provider: input.provider,
        model: input.model,
        dimensions: input.dimensions,
        trigger: input.trigger,
        mode: input.mode,
        status: 'running',
        totalCandidates: input.totalCandidates,
        startedAt: input.now,
        updatedAt: input.now,
    });
}
export async function finalizeBackfillRun(db, id, input) {
    const terminal = input.status !== 'running';
    await db
        .update(Runs)
        .set({
        status: input.status,
        ...(input.mode ? { mode: input.mode } : {}),
        totalCandidates: input.counts.totalCandidates,
        processedCount: input.counts.processedCount,
        readyCount: input.counts.readyCount,
        skippedReadyCount: input.counts.skippedReadyCount,
        retryableCount: input.counts.retryableCount,
        blockedCount: input.counts.blockedCount,
        pauseReason: input.pauseReason ?? null,
        lastErrorCode: input.lastErrorCode ?? null,
        lastErrorMessage: input.lastErrorMessage ?? null,
        resumeAfter: input.resumeAfter ?? null,
        updatedAt: input.now,
        completedAt: terminal ? input.now : null,
    })
        .where(eq(Runs.id, id));
}
/** Latest run for the scope, used by status surfaces to report pause state. */
export async function getLatestBackfillRun(db, appId, agentId) {
    const [row] = await db
        .select()
        .from(Runs)
        .where(and(eq(Runs.appId, appId), agentId
        ? or(eq(Runs.agentId, agentId), isNull(Runs.agentId))
        : isNull(Runs.agentId)))
        .orderBy(desc(Runs.startedAt))
        .limit(1);
    return row ?? null;
}
/** Active provider/model pause that should suppress new provider calls. */
export async function getActiveBackfillPause(db, input) {
    const [row] = await db
        .select()
        .from(Runs)
        .where(and(eq(Runs.appId, input.appId), eq(Runs.provider, input.provider), eq(Runs.model, input.model), eq(Runs.dimensions, input.dimensions), eq(Runs.status, 'paused'), sql `${Runs.resumeAfter} is not null`, sql `${Runs.resumeAfter} > ${input.now}::timestamptz`, input.agentId
        ? or(eq(Runs.agentId, input.agentId), isNull(Runs.agentId))
        : undefined))
        .orderBy(desc(Runs.resumeAfter), desc(Runs.startedAt))
        .limit(1);
    return row ?? null;
}
