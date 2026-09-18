import { describe, expect, it, vi } from 'vitest';

import { ExternalCapabilityTaskService } from '@core/application/capabilities/external-capability-task-service.js';
import type {
  AsyncTaskCreateInput,
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '@core/domain/ports/async-tasks.js';

describe('external capability task predecessor binding', () => {
  it('binds only the newest completed exact-scope predecessor', async () => {
    const exact = completedTask({
      id: 'task-exact',
      updatedAt: '2026-09-12T02:00:00.000Z',
    });
    const repository = repositoryWithTasks([
      completedTask({ id: 'task-wrong-job', parentJobId: 'job-2' }),
      completedTask({ id: 'task-wrong-operation', operation: 'recipe_compile' }),
      completedTask({ id: 'task-older', updatedAt: '2026-09-12T01:00:00.000Z' }),
      exact,
    ]);
    const service = new ExternalCapabilityTaskService(repository);

    const accepted = await service.accept(acceptance());

    expect(accepted.created).toBe(true);
    expect(repository.createdInput?.privateCorrelationJson).toMatchObject({
      previousCapabilityTaskId: exact.id,
    });
  });

  it('preserves the admission-bound predecessor on idempotent replay', async () => {
    const original = completedTask({ id: 'task-original' });
    let tasks = [original];
    let admitted: AsyncTaskRecord | null = null;
    const repository = {
      listTasks: vi.fn(async () => tasks),
      createTaskIdempotently: vi.fn(async (input: AsyncTaskCreateInput) => {
        if (admitted) return { created: false, task: admitted };
        admitted = {
          ...input,
          heartbeatAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
          startedAt: null,
          terminalAt: null,
          outputSummary: null,
          errorSummary: null,
          receiptJson: null,
        } as AsyncTaskRecord;
        return { created: true, task: admitted };
      }),
    } as unknown as AsyncTaskRepository;
    const service = new ExternalCapabilityTaskService(repository);

    await service.accept(acceptance());
    tasks = [
      original,
      completedTask({
        id: 'task-newer',
        updatedAt: '2026-09-12T03:00:00.000Z',
      }),
    ];
    const replay = await service.accept(acceptance());

    expect(replay.created).toBe(false);
    expect(admitted?.privateCorrelationJson).toMatchObject({
      previousCapabilityTaskId: original.id,
    });
  });
});

function acceptance() {
  return {
    appId: 'manipal-tender-copilot',
    agentId: 'agent:website-recipe',
    conversationId: 'conversation-1',
    threadId: null,
    jobId: 'job-1',
    runId: 'run-1',
    capabilityId: 'manipal.website-recipe-evaluator@15',
    operation: 'validate_recipe',
    contentDigest: `sha256:${'a'.repeat(64)}`,
    invocationRef: 'invocation-1',
    idempotencyKey: 'validation-1',
    executionMode: 'gantry_hosted' as const,
  };
}

function completedTask(
  overrides: {
    id: string;
    parentJobId?: string;
    operation?: string;
    updatedAt?: string;
  },
): AsyncTaskRecord {
  const now = overrides.updatedAt ?? '2026-09-12T00:00:00.000Z';
  return {
    id: overrides.id,
    appId: 'manipal-tender-copilot',
    agentId: 'agent:website-recipe',
    conversationId: 'conversation-1',
    threadId: null,
    parentRunId: 'run-previous',
    parentJobId: overrides.parentJobId ?? 'job-1',
    parentJobRunId: null,
    kind: 'external_capability',
    status: 'completed',
    admissionClass: 'task',
    authoritySnapshotJson: {
      capabilityId: 'manipal.website-recipe-evaluator@15',
      operation: overrides.operation ?? 'validate_recipe',
      contentDigest: `sha256:${overrides.id.padEnd(64, '0').slice(0, 64)}`,
    },
    privateCorrelationJson: { result: { status: 'revision_required' } },
    idempotencyKey: overrides.id,
    leaseToken: `lease-${overrides.id}`,
    fencingVersion: 1,
    heartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    terminalAt: now,
    summary: null,
    outputSummary: null,
    errorSummary: null,
    receiptJson: null,
  };
}

function repositoryWithTasks(tasks: AsyncTaskRecord[]): AsyncTaskRepository & {
  createdInput?: AsyncTaskCreateInput;
} {
  const repository = {
    createdInput: undefined as AsyncTaskCreateInput | undefined,
    listTasks: vi.fn(async () => tasks),
    createTaskIdempotently: vi.fn(async (input: AsyncTaskCreateInput) => {
      repository.createdInput = input;
      return {
        created: true,
        task: {
          ...input,
          heartbeatAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
          startedAt: null,
          terminalAt: null,
          outputSummary: null,
          errorSummary: null,
          receiptJson: null,
        } as AsyncTaskRecord,
      };
    }),
  };
  return repository as unknown as AsyncTaskRepository & {
    createdInput?: AsyncTaskCreateInput;
  };
}
