import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import { nowIso } from '@core/shared/time/datetime.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

function makeJob(id: string): JobUpsertInput {
  const now = nowIso();
  return {
    id,
    name: 'Coordination race',
    prompt: 'Check coordination state',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    workspace_key: 'coordination_agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: true,
    timeout_ms: 30_000,
    max_retries: 3,
    retry_backoff_ms: 1,
    max_consecutive_failures: 5,
    consecutive_failures: 0,
    pause_reason: null,
    execution_context: {
      conversationJid: 'tg:coordination',
      threadId: null,
      workspaceKey: 'coordination_agent',
      sessionId: null,
    },
    setup_state: {
      state: 'missing_capability',
      checked_at: now,
      fingerprint: 'fingerprint-1',
      notified_fingerprint: null,
      blockers: [
        {
          state: 'missing_capability',
          type: 'semantic_capability',
          id: 'capability:coordination-test',
          summary: 'A required capability is missing for this job.',
          action: {
            kind: 'instruction',
            text: 'Provision the missing capability, then resume the job.',
          },
        },
      ],
    },
  };
}

maybeDescribe('job coordination state (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'job_coordination_state',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('keeps concurrent coordination writes intact', async () => {
    const jobId = 'job-coordination-race';
    const job = makeJob(jobId);
    await runtime.ops.upsertJob(job);

    await Promise.all([
      runtime.ops.markJobSetupNotified(jobId, 'fingerprint-1'),
      runtime.ops.updateJob(jobId, {
        status: 'paused',
        pause_reason: 'Setup required',
        setup_state: {
          ...job.setup_state!,
          checked_at: nowIso(),
        },
      }),
    ]);

    await expect(runtime.ops.getJobById(jobId)).resolves.toMatchObject({
      status: 'paused',
      pause_reason: 'Setup required',
      setup_state: {
        fingerprint: 'fingerprint-1',
        notified_fingerprint: 'fingerprint-1',
      },
    });

    await Promise.all([
      runtime.ops.updateJob(
        jobId,
        { consecutive_failures: 1 },
        { incrementConsecutiveFailures: true },
      ),
      runtime.ops.updateJob(
        jobId,
        { consecutive_failures: 1 },
        { incrementConsecutiveFailures: true },
      ),
    ]);
    await expect(runtime.ops.getJobById(jobId)).resolves.toMatchObject({
      consecutive_failures: 2,
    });

    await runtime.ops.updateJob(jobId, {
      setup_state: {
        ...job.setup_state!,
        fingerprint: 'fingerprint-2',
        checked_at: nowIso(),
      },
    });
    await expect(
      runtime.ops.markJobSetupNotified(jobId, 'fingerprint-1'),
    ).resolves.toBe(false);
    await expect(runtime.ops.getJobById(jobId)).resolves.toMatchObject({
      pause_reason: 'Setup required',
      setup_state: {
        fingerprint: 'fingerprint-2',
        notified_fingerprint: null,
      },
    });
  });
});
