import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExternalCapabilityTaskService } from '@core/jobs/external-capability-task-service.js';
import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
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
    name: 'External capability task test',
    prompt: 'Wait for evaluator completion',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: null,
    execution_context: {
      conversationJid: 'control:external-capability-test',
      threadId: null,
      workspaceKey: 'external_capability_agent',
      sessionId: null,
    },
    workspace_key: 'external_capability_agent',
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

maybeDescribe('external capability tasks', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'external_capability_task',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('resumes an externally completed capability task exactly once', async () => {
    const jobId = 'job-external-capability';
    const runId = 'run-external-capability';
    const agentId = 'agent:external_capability_agent';
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
    const service = new ExternalCapabilityTaskService(
      runtime.repositories.asyncTasks,
    );
    const acceptanceInput = {
      appId: 'default',
      agentId,
      conversationId: 'control:external-capability-test',
      jobId,
      runId,
      capabilityId: 'manipal.website-recipe-evaluator@1',
      operation: 'evaluation.submit',
      invocationRef: 'evaluation:eval-1',
      idempotencyKey: 'recipe-job:attempt-1:candidate:test-plan',
    };
    const [first, duplicate] = await Promise.all([
      service.accept(acceptanceInput),
      service.accept(acceptanceInput),
    ]);
    const created = first.created ? first : duplicate;
    const replay = first.created ? duplicate : first;
    expect(created).toMatchObject({
      status: 'waiting_external',
      created: true,
    });
    expect(created.completionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(replay).toEqual({
      taskId: created.taskId,
      completionToken: '',
      status: 'waiting_external',
      created: false,
    });

    await expect(
      service.accept({ ...acceptanceInput, invocationRef: 'evaluation:other' }),
    ).rejects.toThrow('reused for different work');

    await expect(
      service.complete({
        appId: 'other-app',
        taskId: created.taskId,
        completionToken: created.completionToken,
        completionId: 'completion-1',
        resultRef: 'artifact:result-1',
        summary: 'Evaluation passed.',
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
    await expect(
      service.complete({
        appId: 'default',
        taskId: created.taskId,
        completionToken: 'wrong-token',
        completionId: 'completion-1',
        resultRef: 'artifact:result-1',
        summary: 'Evaluation passed.',
      }),
    ).resolves.toEqual({ outcome: 'forbidden' });

    const rotated = await service.recover({
      appId: 'default',
      idempotencyKey: acceptanceInput.idempotencyKey,
      capabilityId: acceptanceInput.capabilityId,
      operation: acceptanceInput.operation,
    });
    expect(rotated).toMatchObject({
      taskId: created.taskId,
      status: 'waiting_external',
      created: false,
    });
    expect(rotated?.completionToken).not.toBe(created.completionToken);
    await expect(
      service.complete({
        appId: 'default',
        taskId: created.taskId,
        completionToken: created.completionToken,
        completionId: 'completion-stale-token',
        resultRef: 'artifact:stale',
        summary: 'Stale completion.',
      }),
    ).resolves.toEqual({ outcome: 'forbidden' });

    const completed = await service.complete({
      appId: 'default',
      taskId: created.taskId,
      completionToken: rotated!.completionToken,
      completionId: 'completion-1',
      resultRef: 'artifact:result-1',
      summary: 'Evaluation passed.',
      result: { status: 'proven', missingRequirementIds: [] },
    });
    expect(completed).toMatchObject({
      outcome: 'completed',
      task: {
        id: created.taskId,
        status: 'completed',
        outputSummary: 'Evaluation passed.',
        privateCorrelationJson: {
          completionId: 'completion-1',
          resultRef: 'artifact:result-1',
          result: { status: 'proven', missingRequirementIds: [] },
        },
      },
    });
    await expect(service.accept(acceptanceInput)).resolves.toEqual({
      taskId: created.taskId,
      completionToken: '',
      status: 'completed',
      created: false,
    });

    await expect(
      service.complete({
        appId: 'default',
        taskId: created.taskId,
        completionToken: rotated!.completionToken,
        completionId: 'completion-1',
        resultRef: 'artifact:result-1',
        summary: 'Evaluation passed.',
      }),
    ).resolves.toMatchObject({ outcome: 'idempotent' });
    await expect(
      service.complete({
        appId: 'default',
        taskId: created.taskId,
        completionToken: rotated!.completionToken,
        completionId: 'completion-late',
        resultRef: 'artifact:late',
        summary: 'Late replacement.',
      }),
    ).resolves.toMatchObject({ outcome: 'late_ignored' });

    const stored = await runtime.repositories.asyncTasks.getTask(
      created.taskId,
    );
    expect(stored).toMatchObject({
      status: 'completed',
      idempotencyKey: acceptanceInput.idempotencyKey,
      outputSummary: 'Evaluation passed.',
    });
    expect(stored?.privateCorrelationJson).not.toHaveProperty(
      'completionToken',
    );
  });
});
