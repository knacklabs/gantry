import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { DelegatedTaskScope } from '@core/domain/ports/task-lifecycle.js';
import type { PostgresIntegrationRuntime } from '../harness/postgres-integration-runtime.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const baseScope: DelegatedTaskScope = {
  appId: DEFAULT_APP_ID,
  agentId: DEFAULT_AGENT_ID,
  principalId: 'sl:C123',
  conversationId: 'sl:C123',
  threadId: 'thread-1',
  parentRunId: null,
  runHandle: 'run-1',
};

maybeDescribe('Postgres task lifecycle repository', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'task_lifecycle',
    });
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('persists todo state, idempotent delegated tasks, scope checks, cancellation, and stale fences', async () => {
    const repo = runtime.repositories.taskLifecycle;
    const now = '2026-06-17T00:00:00.000Z';

    const todo = await repo.recordTodoUpdate({
      id: 'todo-1',
      scope: baseScope,
      summary: 'Plan',
      items: [{ id: 'step-1', title: 'Start', status: 'pending' }],
      idempotencyKey: 'todo-key-1',
      fencingVersion: 7,
      now,
    });
    expect(todo.outcome).toBe('created');
    expect(todo.update.items).toEqual([
      { id: 'step-1', title: 'Start', status: 'pending' },
    ]);

    const todoReplay = await repo.recordTodoUpdate({
      id: 'todo-duplicate',
      scope: baseScope,
      summary: 'Plan',
      items: [{ id: 'step-1', title: 'Start', status: 'pending' }],
      idempotencyKey: 'todo-key-1',
      now,
    });
    expect(todoReplay).toMatchObject({
      outcome: 'replayed',
      update: { id: 'todo-1' },
    });

    const delegated = await repo.launchDelegatedTask({
      id: 'task-1',
      scope: baseScope,
      idempotencyKey: 'delegate-key-1',
      capabilityScope: 'AgentDelegation',
      ownerWorkerId: 'worker-1',
      title: 'Research',
      task: 'Compare options',
      expectedOutput: 'Decision notes',
      context: 'Keep concise',
      now,
    });
    expect(delegated.outcome).toBe('created');
    expect(delegated.task).toMatchObject({
      id: 'task-1',
      status: 'running',
      providerCorrelation: {},
      terminalReceipt: null,
    });

    const delegatedReplay = await repo.launchDelegatedTask({
      id: 'task-duplicate',
      scope: baseScope,
      idempotencyKey: 'delegate-key-1',
      capabilityScope: 'AgentDelegation',
      title: 'Research',
      task: 'Compare options',
      expectedOutput: 'Decision notes',
      now,
    });
    expect(delegatedReplay).toMatchObject({
      outcome: 'replayed',
      task: { id: 'task-1' },
    });

    await expect(
      repo.getDelegatedTask({
        taskId: 'task-1',
        scope: { ...baseScope, conversationId: 'sl:OTHER' },
        now,
      }),
    ).resolves.toEqual({ outcome: 'forbidden' });

    const cancelled = await repo.cancelDelegatedTask({
      taskId: 'task-1',
      scope: baseScope,
      reason: 'No longer needed',
      now: '2026-06-17T00:01:00.000Z',
    });
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.task).toMatchObject({
      status: 'cancelled',
      cancelReason: 'No longer needed',
      terminalReceipt: {
        completed: 'Cancelled before delegated work completed.',
        used: 'AgentDelegation',
        changed: 'none',
        delegated: 'yes',
        needsAttention: 'none',
      },
    });

    await expect(
      repo.cancelDelegatedTask({
        taskId: 'task-1',
        scope: baseScope,
        now: '2026-06-17T00:02:00.000Z',
      }),
    ).resolves.toMatchObject({
      outcome: 'already_terminal',
      task: { status: 'cancelled' },
    });

    await repo.launchDelegatedTask({
      id: 'task-stale-fence',
      scope: {
        ...baseScope,
        parentRunId: 'run-with-missing-active-lease',
        runHandle: 'run-stale',
      },
      idempotencyKey: 'delegate-key-stale',
      capabilityScope: 'AgentDelegation',
      fence: { leaseToken: 'lease-stale', fencingVersion: 9 },
      title: 'Stale',
      task: 'Should not be readable under a missing active lease',
      expectedOutput: 'No output',
      now,
    });

    await expect(
      repo.getDelegatedTask({
        taskId: 'task-stale-fence',
        scope: {
          ...baseScope,
          parentRunId: 'run-with-missing-active-lease',
          runHandle: 'run-stale',
        },
        fence: { leaseToken: 'lease-stale', fencingVersion: 9 },
        now: '2026-06-17T00:03:00.000Z',
      }),
    ).resolves.toEqual({ outcome: 'stale_fence' });
  });
});
