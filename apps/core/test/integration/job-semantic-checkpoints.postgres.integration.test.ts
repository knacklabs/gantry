import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import { jobArtifactScope } from '@core/domain/ports/job-semantic-checkpoints.js';
import { nowIso } from '@core/shared/time/datetime.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

function job(id: string): JobUpsertInput {
  const now = nowIso();
  return {
    id,
    name: 'Recipe checkpoint test',
    prompt: 'Create a website recipe',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: null,
    execution_context: {
      conversationJid: 'control:recipe-checkpoint-test',
      threadId: null,
      workspaceKey: 'recipe_checkpoint_agent',
      sessionId: null,
    },
    workspace_key: 'recipe_checkpoint_agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: true,
    timeout_ms: 60_000,
    max_retries: 1,
    retry_backoff_ms: 1,
  };
}

maybeDescribe('job semantic checkpoints', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'job_semantic_checkpoints',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('persists only fenced semantic job checkpoints', async () => {
    const jobId = 'job-recipe-checkpoint';
    const runId = 'run-recipe-checkpoint';
    const agentId = 'agent:recipe_checkpoint_agent';
    await runtime.ops.upsertJob(job(jobId));
    await runtime.ops.createJobRun({
      run_id: runId,
      job_id: jobId,
      execution_provider_id: 'anthropic:claude-agent-sdk',
      scheduled_for: nowIso(),
      started_at: nowIso(),
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    await runtime.repositories.workerCoordination.registerWorker({
      id: 'worker-recipe-checkpoint-1',
      bootNonce: 'boot-1',
    });
    const firstLease =
      await runtime.repositories.workerCoordination.claimRunLease({
        runId,
        jobId,
        workerInstanceId: 'worker-recipe-checkpoint-1',
        ttlMs: 60_000,
      });
    expect(firstLease).not.toBeNull();

    const artifact = {
      id: 'artifact-recipe-inventory',
      contentHash: `sha256:${'a'.repeat(64)}`,
    };
    await runtime.service.pool.query(
      `INSERT INTO file_artifacts
        (id, app_id, agent_id, virtual_scope, virtual_path, version,
         storage_type, storage_ref, content_hash, size_bytes, content_type,
         metadata_json, created_by, created_at)
       VALUES ($1, 'default', $2, $3, 'inventory.json', 1,
         'local-filesystem', 'test-only', $4, 15, 'application/json',
         '{}', $2, now())`,
      [
        artifact.id,
        agentId,
        jobArtifactScope(jobId),
        artifact.contentHash,
      ],
    );
    const payload = {
      safePhase: 'inventory_complete',
      artifactRefs: [
        {
          artifactId: artifact.id,
          contentHash: artifact.contentHash,
          kind: 'inventory',
        },
      ],
      nextAction: 'Draft the first candidate recipe.',
      cumulativeRuntimeMs: 12_000,
      cookies: 'must-not-be-persisted',
    };
    const repository = runtime.repositories.jobSemanticCheckpoints;
    const persisted = await repository.appendCheckpoint({
      id: 'checkpoint-inventory',
      appId: 'default',
      agentId,
      jobId,
      runId,
      leaseToken: firstLease!.leaseToken,
      expectedPreviousSequence: 0,
      milestone: 'inventory_completed',
      payload,
    });
    expect(persisted).toMatchObject({
      outcome: 'persisted',
      checkpoint: {
        sequence: 1,
        fencingVersion: firstLease!.fencingVersion,
        milestone: 'inventory_completed',
        payload: {
          safePhase: payload.safePhase,
          artifactRefs: payload.artifactRefs,
          evaluatorInvocationRef: null,
          pendingInteractionRef: null,
          nextAction: payload.nextAction,
          cumulativeRuntimeMs: payload.cumulativeRuntimeMs,
        },
      },
    });
    expect(
      'cookies' in
        (persisted.outcome === 'persisted' ? persisted.checkpoint.payload : {}),
    ).toBe(false);

    await expect(
      repository.appendCheckpoint({
        id: 'checkpoint-inventory',
        appId: 'default',
        agentId,
        jobId,
        runId,
        leaseToken: firstLease!.leaseToken,
        expectedPreviousSequence: 0,
        milestone: 'inventory_completed',
        payload,
      }),
    ).resolves.toMatchObject({
      outcome: 'replayed',
      checkpoint: { sequence: 1 },
    });

    await expect(
      repository.appendCheckpoint({
        id: 'checkpoint-conflict',
        appId: 'default',
        agentId,
        jobId,
        runId,
        leaseToken: firstLease!.leaseToken,
        expectedPreviousSequence: 0,
        milestone: 'candidate_created',
        payload: { ...payload, nextAction: 'Compile the candidate.' },
      }),
    ).resolves.toEqual({ outcome: 'sequence_conflict', latestSequence: 1 });

    await expect(
      repository.appendCheckpoint({
        id: 'checkpoint-wrong-agent',
        appId: 'default',
        agentId: 'agent:not_the_job_owner',
        jobId,
        runId,
        leaseToken: firstLease!.leaseToken,
        expectedPreviousSequence: 1,
        milestone: 'candidate_created',
        payload: { ...payload, nextAction: 'Compile the candidate.' },
      }),
    ).rejects.toThrow('not owned by the supplied app and agent');

    await expect(
      repository.appendCheckpoint({
        id: 'checkpoint-expired-lease',
        appId: 'default',
        agentId,
        jobId,
        runId,
        leaseToken: firstLease!.leaseToken,
        expectedPreviousSequence: 1,
        milestone: 'runtime_boundary',
        payload: { ...payload, nextAction: 'Resume from a fresh lease.' },
        now: new Date(Date.parse(firstLease!.expiresAt) + 1).toISOString(),
      }),
    ).resolves.toEqual({ outcome: 'fenced' });

    await runtime.repositories.workerCoordination.settleRunLease({
      runId,
      leaseToken: firstLease!.leaseToken,
      workerInstanceId: firstLease!.workerInstanceId,
      fencingVersion: firstLease!.fencingVersion,
      outcome: 'released',
    });
    await runtime.repositories.workerCoordination.registerWorker({
      id: 'worker-recipe-checkpoint-2',
      bootNonce: 'boot-2',
    });
    const recoveredLease =
      await runtime.repositories.workerCoordination.claimRunLease({
        runId,
        jobId,
        workerInstanceId: 'worker-recipe-checkpoint-2',
        ttlMs: 60_000,
      });
    expect(recoveredLease!.fencingVersion).toBeGreaterThan(
      firstLease!.fencingVersion,
    );

    await expect(
      repository.appendCheckpoint({
        id: 'checkpoint-stale-worker',
        appId: 'default',
        agentId,
        jobId,
        runId,
        leaseToken: firstLease!.leaseToken,
        expectedPreviousSequence: 1,
        milestone: 'candidate_created',
        payload: { ...payload, nextAction: 'Compile the candidate.' },
      }),
    ).resolves.toEqual({ outcome: 'fenced' });

    const second = await repository.appendCheckpoint({
      id: 'checkpoint-candidate',
      appId: 'default',
      agentId,
      jobId,
      runId,
      leaseToken: recoveredLease!.leaseToken,
      expectedPreviousSequence: 1,
      milestone: 'candidate_created',
      payload: { ...payload, nextAction: 'Compile the candidate.' },
    });
    expect(second).toMatchObject({
      outcome: 'persisted',
      checkpoint: {
        sequence: 2,
        workerInstanceId: 'worker-recipe-checkpoint-2',
      },
    });

    const latest = await repository.getLatestCheckpoint({
      appId: 'default',
      agentId,
      jobId,
    });
    expect(latest).toMatchObject({ id: 'checkpoint-candidate', sequence: 2 });
    expect(latest?.payloadHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    await runtime.service.pool.query(
      `INSERT INTO file_artifacts
        (id, app_id, agent_id, virtual_scope, virtual_path, version,
         storage_type, storage_ref, content_hash, size_bytes, content_type,
         metadata_json, created_by, created_at)
       VALUES ('artifact-other-run', 'default', $1, 'unrelated',
         'other.json', 1, 'local-filesystem', 'test-only', $2, 2,
         'application/json', '{}', $1, now())`,
      [agentId, `sha256:${'b'.repeat(64)}`],
    );
    await expect(
      repository.appendCheckpoint({
        id: 'checkpoint-cross-run-artifact',
        appId: 'default',
        agentId,
        jobId,
        runId,
        leaseToken: recoveredLease!.leaseToken,
        expectedPreviousSequence: 2,
        milestone: 'test_plan_created',
        payload: {
          safePhase: 'test_plan_complete',
          artifactRefs: [
            {
              artifactId: 'artifact-other-run',
              contentHash: `sha256:${'b'.repeat(64)}`,
              kind: 'test_plan',
            },
          ],
          nextAction: 'Submit evaluation.',
          cumulativeRuntimeMs: 14_000,
        },
      }),
    ).rejects.toThrow('is not an immutable artifact in this job');

    await expect(
      repository.appendCheckpoint({
        id: 'checkpoint-unsupported-milestone',
        appId: 'default',
        agentId,
        jobId,
        runId,
        leaseToken: recoveredLease!.leaseToken,
        expectedPreviousSequence: 2,
        milestone: 'browser_clicked' as never,
        payload: { ...payload, nextAction: 'Do not checkpoint clicks.' },
      }),
    ).rejects.toThrow('Unsupported semantic checkpoint milestone');

    await runtime.service.pool.query(
      `UPDATE job_semantic_checkpoints
       SET payload_json = jsonb_set(payload_json, '{nextAction}', '"tampered"')
       WHERE id = 'checkpoint-candidate'`,
    );
    await expect(
      repository.getLatestCheckpoint({
        appId: 'default',
        agentId,
        jobId,
      }),
    ).rejects.toThrow('failed hash verification');
  });
});
