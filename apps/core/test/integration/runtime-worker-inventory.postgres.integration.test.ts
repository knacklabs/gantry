import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresWorkerInventorySnapshotRepository } from '@core/adapters/storage/postgres/repositories/worker-inventory-snapshot-repository.postgres.js';
import type { WorkerInventorySnapshot } from '@core/runtime/worker-inventory-snapshot.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const BASE_TIME = new Date('2026-06-17T12:00:00.000Z');

function at(ms: number): string {
  return new Date(BASE_TIME.getTime() + ms).toISOString();
}

function snapshot(
  instanceId: string,
  lastHeartbeatAt: string,
  overrides: Partial<WorkerInventorySnapshot> = {},
): WorkerInventorySnapshot {
  return {
    instanceId,
    hostname: `${instanceId}.local`,
    startedAt: at(0),
    lastHeartbeatAt,
    warmPool: {
      availableTarget: 2,
      genericAvailable: 1,
      genericStarting: 1,
      boundActive: 0,
      boundIdle: 0,
      boundDraining: 0,
      maxBoundWorkers: 4,
      cachePrewarm: {
        pending: 0,
        succeeded: 1,
        skipped: 0,
        failed: 0,
      },
      cacheShapes: [
        {
          cacheShapeKey: `shape:${instanceId}`,
          status: 'succeeded',
          workers: 1,
        },
      ],
    },
    queue: {
      activeMessageRuns: 1,
      pendingConversationKeys: 2,
      maxMessageRuns: 3,
    },
    ...overrides,
  };
}

maybeDescribe('PostgresWorkerInventorySnapshotRepository integration', () => {
  let runtime: PostgresIntegrationRuntime;
  let repository: PostgresWorkerInventorySnapshotRepository;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'runtime_worker_inventory',
    });
    repository = new PostgresWorkerInventorySnapshotRepository(
      runtime.service.db,
    );
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('upserts one heartbeat row per app and runtime instance', async () => {
    await repository.saveSnapshot({
      appId: 'default',
      snapshot: snapshot('runtime:a', at(1_000)),
      now: at(1_000),
    });
    await repository.saveSnapshot({
      appId: 'default',
      snapshot: snapshot('runtime:b', at(2_000)),
      now: at(2_000),
    });
    await repository.saveSnapshot({
      appId: 'default',
      snapshot: snapshot('runtime:a', at(3_000), {
        queue: {
          activeMessageRuns: 5,
          pendingConversationKeys: 8,
          maxMessageRuns: 13,
        },
      }),
      now: at(3_000),
    });

    const rows = await repository.listSnapshots({
      appId: 'default',
      limit: 10,
    });

    expect(rows.map((row) => row.instanceId)).toEqual([
      'runtime:a',
      'runtime:b',
    ]);
    expect(rows[0].lastHeartbeatAt).toBe(at(3_000));
    expect(rows[0].queue).toEqual({
      activeMessageRuns: 5,
      pendingConversationKeys: 8,
      maxMessageRuns: 13,
    });

    const raw = await runtime.service.pool.query(
      `SELECT instance_id FROM ${runtime.schemaName}.runtime_worker_inventory_snapshots
       WHERE app_id = $1 AND instance_id = $2`,
      ['default', 'runtime:a'],
    );
    expect(raw.rowCount).toBe(1);
  });

  it('deletes rows older than the retention cutoff', async () => {
    await repository.saveSnapshot({
      appId: 'retention',
      snapshot: snapshot('runtime:old', at(0)),
      now: at(0),
    });
    await repository.saveSnapshot({
      appId: 'retention',
      snapshot: snapshot('runtime:fresh', at(60_000)),
      now: at(60_000),
    });

    const deleted = await repository.deleteSnapshotsOlderThan({
      appId: 'retention',
      before: at(30_000),
    });

    expect(deleted).toBe(1);
    await expect(
      repository.listSnapshots({ appId: 'retention', limit: 10 }),
    ).resolves.toEqual([snapshot('runtime:fresh', at(60_000))]);
  });
});
