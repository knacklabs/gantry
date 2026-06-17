import { and, desc, eq, lt } from 'drizzle-orm';

import type {
  DeleteWorkerInventorySnapshotsOlderThanInput,
  ListWorkerInventorySnapshotsInput,
  SaveWorkerInventorySnapshotInput,
  WorkerInventoryQueueSnapshot,
  WorkerInventorySnapshot,
  WorkerInventorySnapshotRepository,
  WorkerInventoryWarmPoolSnapshot,
} from '../../../../domain/ports/worker-inventory-repository.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

type WorkerInventoryRow =
  typeof pgSchema.runtimeWorkerInventorySnapshotsPostgres.$inferSelect;

function normalizeTimestamp(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

function mapRow(row: WorkerInventoryRow): WorkerInventorySnapshot {
  return {
    instanceId: row.instanceId,
    hostname: row.hostname,
    startedAt: normalizeTimestamp(row.startedAt),
    lastHeartbeatAt: normalizeTimestamp(row.lastHeartbeatAt),
    warmPool: row.warmPoolJson as WorkerInventoryWarmPoolSnapshot,
    queue: row.queueJson as WorkerInventoryQueueSnapshot,
  };
}

export class PostgresWorkerInventorySnapshotRepository implements WorkerInventorySnapshotRepository {
  constructor(private readonly db: CanonicalDb) {}

  async saveSnapshot(input: SaveWorkerInventorySnapshotInput): Promise<void> {
    const now = input.now ?? new Date().toISOString();
    const snapshot = input.snapshot;
    await this.db
      .insert(pgSchema.runtimeWorkerInventorySnapshotsPostgres)
      .values({
        appId: input.appId,
        instanceId: snapshot.instanceId,
        hostname: snapshot.hostname,
        startedAt: snapshot.startedAt,
        lastHeartbeatAt: snapshot.lastHeartbeatAt,
        warmPoolJson: snapshot.warmPool,
        queueJson: snapshot.queue,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          pgSchema.runtimeWorkerInventorySnapshotsPostgres.appId,
          pgSchema.runtimeWorkerInventorySnapshotsPostgres.instanceId,
        ],
        set: {
          hostname: snapshot.hostname,
          startedAt: snapshot.startedAt,
          lastHeartbeatAt: snapshot.lastHeartbeatAt,
          warmPoolJson: snapshot.warmPool,
          queueJson: snapshot.queue,
          updatedAt: now,
        },
      });
  }

  async listSnapshots(
    input: ListWorkerInventorySnapshotsInput,
  ): Promise<WorkerInventorySnapshot[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.runtimeWorkerInventorySnapshotsPostgres)
      .where(
        eq(pgSchema.runtimeWorkerInventorySnapshotsPostgres.appId, input.appId),
      )
      .orderBy(
        desc(pgSchema.runtimeWorkerInventorySnapshotsPostgres.lastHeartbeatAt),
        desc(pgSchema.runtimeWorkerInventorySnapshotsPostgres.instanceId),
      )
      .limit(input.limit ?? 100);

    return rows.map(mapRow);
  }

  async deleteSnapshotsOlderThan(
    input: DeleteWorkerInventorySnapshotsOlderThanInput,
  ): Promise<number> {
    const deleted = await this.db
      .delete(pgSchema.runtimeWorkerInventorySnapshotsPostgres)
      .where(
        and(
          eq(
            pgSchema.runtimeWorkerInventorySnapshotsPostgres.appId,
            input.appId,
          ),
          lt(
            pgSchema.runtimeWorkerInventorySnapshotsPostgres.lastHeartbeatAt,
            input.before,
          ),
        ),
      )
      .returning({
        instanceId: pgSchema.runtimeWorkerInventorySnapshotsPostgres.instanceId,
      });
    return deleted.length;
  }
}
