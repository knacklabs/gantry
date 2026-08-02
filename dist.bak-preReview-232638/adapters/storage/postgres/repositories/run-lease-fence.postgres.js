import { sql } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
export function activeRunLeaseTokenFence(input) {
    const workerFence = input.workerInstanceId !== undefined
        ? sql `AND ${pgSchema.runLeasesPostgres.workerInstanceId} = ${input.workerInstanceId}`
        : sql ``;
    return sql `EXISTS (
    SELECT 1 FROM ${pgSchema.runLeasesPostgres}
    WHERE ${pgSchema.runLeasesPostgres.runId} = ${input.runId}
      ${workerFence}
      AND ${pgSchema.runLeasesPostgres.leaseToken} = ${input.leaseToken}
      AND ${pgSchema.runLeasesPostgres.fencingVersion} = ${input.fencingVersion}
      AND ${pgSchema.runLeasesPostgres.status} = 'active'
      AND ${pgSchema.runLeasesPostgres.expiresAt} > ${input.now}
  )`;
}
export function activeRunLeaseFence(input) {
    return activeRunLeaseTokenFence({
        runId: input.runId,
        leaseToken: input.fence.leaseToken,
        workerInstanceId: input.fence.workerInstanceId,
        fencingVersion: input.fence.fencingVersion,
        now: input.now,
    });
}
export function settledRunLeaseFence(input) {
    return sql `EXISTS (
    SELECT 1 FROM ${pgSchema.runLeasesPostgres}
    WHERE ${pgSchema.runLeasesPostgres.runId} = ${input.runId}
      AND ${pgSchema.runLeasesPostgres.workerInstanceId} = ${input.fence.workerInstanceId}
      AND ${pgSchema.runLeasesPostgres.leaseToken} = ${input.fence.leaseToken}
      AND ${pgSchema.runLeasesPostgres.fencingVersion} = ${input.fence.fencingVersion}
      AND ${pgSchema.runLeasesPostgres.status} IN ('completed', 'failed', 'released')
  )`;
}
