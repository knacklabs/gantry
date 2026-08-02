import { and, inArray, sql } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
import { activeRunLeaseFence } from './run-lease-fence.postgres.js';
export async function updateCanonicalJobRunProviderMetadata(db, runId, input) {
    const updates = {};
    if (input.providerRunId !== undefined)
        updates.providerRunId = input.providerRunId;
    if (input.providerSessionId !== undefined) {
        updates.providerSessionId = input.providerSessionId;
    }
    if (Object.keys(updates).length === 0)
        return true;
    const runIds = Array.isArray(runId) ? [...new Set(runId)] : [runId];
    if (runIds.length === 0)
        return true;
    const hasLeaseFence = input.leaseToken !== undefined ||
        input.workerInstanceId !== undefined ||
        input.fencingVersion !== undefined;
    if (hasLeaseFence &&
        (!input.leaseToken ||
            !input.workerInstanceId ||
            input.fencingVersion === undefined)) {
        throw new Error('Run provider metadata lease fence requires leaseToken, workerInstanceId, and fencingVersion.');
    }
    const rows = await db
        .update(pgSchema.agentRunsPostgres)
        .set(updates)
        .where(and(inArray(pgSchema.agentRunsPostgres.id, runIds), ...(input.leaseToken
        ? [
            activeRunLeaseFence({
                runId: input.fenceRunId ?? sql `${pgSchema.agentRunsPostgres.id}`,
                fence: {
                    leaseToken: input.leaseToken,
                    workerInstanceId: input.workerInstanceId,
                    fencingVersion: input.fencingVersion,
                },
                now: sql `now()`,
            }),
        ]
        : [])))
        .returning({ id: pgSchema.agentRunsPostgres.id });
    return rows.length > 0;
}
