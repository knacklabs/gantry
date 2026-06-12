import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The non-executing-role send-only path reads `STORAGE_POSTGRES_URL` (a config
// constant resolved at import time) for its ephemeral pg-boss client. Point that
// at the disposable test database while keeping every other config export real,
// so the real `enqueueJobTrigger` path exercises a real pg-boss connection.
vi.mock('@core/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/config/index.js')>();
  return {
    ...actual,
    get STORAGE_POSTGRES_URL() {
      return process.env.GANTRY_TEST_DATABASE_URL ?? '';
    },
  };
});

import { PgBoss } from 'pg-boss';

import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import {
  _resetSchedulerLoopForTests,
  enqueueJobTrigger,
  markRoleHasNoJobExecution,
} from '@core/jobs/scheduler.js';
import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const now = '2026-06-12T00:00:00.000Z';
const SCHEDULER_QUEUE = 'gantry.jobs';

function makeJob(
  id: string,
  patch: Partial<JobUpsertInput> = {},
): JobUpsertInput {
  return {
    id,
    name: `Job ${id}`,
    prompt: 'Summarize current status',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: 'thread-scheduled',
    execution_context: {
      conversationJid: 'tg:scheduler',
      threadId: 'thread-scheduled',
      workspaceKey: 'scheduler_agent',
      sessionId: null,
    },
    notification_routes: [
      {
        conversationJid: 'tg:scheduler',
        threadId: 'thread-scheduled',
        label: 'primary',
      },
    ],
    workspace_key: 'scheduler_agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: false,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    ...patch,
  } satisfies JobUpsertInput;
}

maybeDescribe('non-executing-role manual job trigger enqueue', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'trigger_nonexec',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
    // The send-only client runs with migrate:false, so the `pgboss` schema and
    // its job table must already exist (as in any fleet, where a job worker
    // boots first). Migrate it once here with a throwaway full client.
    const bootstrap = new PgBoss({
      connectionString: process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schema: 'pgboss',
      schedule: false,
      supervise: false,
    });
    await bootstrap.start();
    await bootstrap.stop({ graceful: false, close: true });
  }, 60_000);

  afterAll(async () => {
    _resetSchedulerLoopForTests();
    await runtime?.cleanup();
  });

  it('enqueues a delivery into the pgboss scheduler queue with no engine running', async () => {
    _resetSchedulerLoopForTests();
    markRoleHasNoJobExecution();

    const jobId = `job:trigger:${randomUUID()}`;
    await runtime.ops.upsertJob(makeJob(jobId));
    const trigger = await runtime.control.createJobTrigger({
      jobId,
      requestedBy: JSON.stringify({ kind: 'test' }),
    });
    const runId = `run:${randomUUID()}`;

    // No active scheduler engine + non-executing role: the trigger must still
    // land in the queue via the ephemeral send-only client.
    await enqueueJobTrigger(jobId, trigger.triggerId, { runId });

    const rows = await runtime.service.pool.query<{
      id: string;
      name: string;
      data: {
        jobId: string;
        triggerId: string;
        runId: string | null;
      } | null;
      group_id: string | null;
    }>(
      `SELECT id, name, data, group_id
         FROM pgboss.job
        WHERE name = $1 AND data->>'triggerId' = $2`,
      [SCHEDULER_QUEUE, trigger.triggerId],
    );

    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0]!;
    // Queue name matches the engine's SCHEDULER_QUEUE constant, so a real engine
    // constructed afterwards would claim this exact row.
    expect(row.name).toBe(SCHEDULER_QUEUE);
    expect(row.data?.jobId).toBe(jobId);
    expect(row.data?.triggerId).toBe(trigger.triggerId);
    expect(row.data?.runId).toBe(runId);
    // Grouped by the job's workspace key so it serializes with that group.
    expect(row.group_id).toBeTruthy();

    // Clean up only this row to stay isolated from any other pgboss user.
    await runtime.service.pool.query(`DELETE FROM pgboss.job WHERE id = $1`, [
      row.id,
    ]);
  });
});
