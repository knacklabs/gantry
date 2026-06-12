import { sql, type SQL } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';

export interface RunLeaseFence {
  leaseToken: string;
  workerInstanceId: string;
  fencingVersion: number;
}

export function activeRunLeaseFence(input: {
  runId: string | SQL;
  fence: RunLeaseFence;
  now: string | SQL;
}): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${pgSchema.runLeasesPostgres}
    WHERE ${pgSchema.runLeasesPostgres.runId} = ${input.runId}
      AND ${pgSchema.runLeasesPostgres.workerInstanceId} = ${input.fence.workerInstanceId}
      AND ${pgSchema.runLeasesPostgres.leaseToken} = ${input.fence.leaseToken}
      AND ${pgSchema.runLeasesPostgres.fencingVersion} = ${input.fence.fencingVersion}
      AND ${pgSchema.runLeasesPostgres.status} = 'active'
      AND ${pgSchema.runLeasesPostgres.expiresAt} > ${input.now}
  )`;
}

export function settledRunLeaseFence(input: {
  runId: string | SQL;
  fence: RunLeaseFence;
  now: string | SQL;
}): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${pgSchema.runLeasesPostgres}
    WHERE ${pgSchema.runLeasesPostgres.runId} = ${input.runId}
      AND ${pgSchema.runLeasesPostgres.workerInstanceId} = ${input.fence.workerInstanceId}
      AND ${pgSchema.runLeasesPostgres.leaseToken} = ${input.fence.leaseToken}
      AND ${pgSchema.runLeasesPostgres.fencingVersion} = ${input.fence.fencingVersion}
      AND ${pgSchema.runLeasesPostgres.status} IN ('completed', 'failed', 'released')
  )`;
}
