import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresAsyncTaskRepository } from '@core/adapters/storage/postgres/repositories/async-task-repository.postgres.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { AsyncCommandTaskService } from '@core/jobs/async-command-task-service.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const CONVERSATION_ID = 'conversation:delegation-integration';
const TARGET_AGENT_ID = 'agent:delegation_reviewer';
const TARGET_AGENT_FOLDER = 'delegation_reviewer';
const PAYLOAD_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');

// Complements the in-memory IPC proof "delegates an async child run to a bound
// target agent" in ipc-agent-task-lifecycle-handlers.test.ts.
maybeDescribe('delegated agent task lifecycle (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    vi.stubEnv('SECRET_ENCRYPTION_KEY', PAYLOAD_ENCRYPTION_KEY);
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'agent_delegation_lifecycle',
    });
    const now = '2026-07-21T00:00:00.000Z';
    await runtime.repositories.agents.saveAgent({
      id: TARGET_AGENT_ID as never,
      appId: DEFAULT_APP_ID as never,
      name: 'Delegation Reviewer',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    try {
      if (runtime) await runtime.cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('persists a delegated task completion and linkage across repository instances', async () => {
    const service = new AsyncCommandTaskService(
      runtime.repositories.asyncTasks,
      { run: async () => ({}) },
    );
    const started = await service.startDelegatedAgent({
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      conversationId: CONVERSATION_ID,
      objective: 'Research durable delegation',
      targetAgentId: TARGET_AGENT_ID,
      authorityToolName: 'AgentDelegation',
      workspaceFolder: TARGET_AGENT_FOLDER,
      run: async () => ({ outputSummary: 'Durable delegated result.' }),
    });

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.message);
    expect(started.task).toMatchObject({
      kind: 'delegated_agent',
      status: 'queued',
    });
    await expect(started.completion.wait(5_000)).resolves.toMatchObject({
      taskId: started.task.id,
      status: 'completed',
      result: 'Durable delegated result.',
    });

    const freshRepository = new PostgresAsyncTaskRepository(runtime.service.db);
    const freshService = new AsyncCommandTaskService(freshRepository, {
      run: async () => ({}),
    });
    await expect(
      freshService.getScoped({
        taskId: started.task.id,
        appId: DEFAULT_APP_ID,
        agentId: DEFAULT_AGENT_ID,
        conversationId: CONVERSATION_ID,
      }),
    ).resolves.toMatchObject({
      id: started.task.id,
      status: 'completed',
      outputSummary: 'Durable delegated result.',
      terminalAt: expect.any(String),
      allowedActions: ['get', 'list'],
    });
    await expect(
      freshRepository.getTask(started.task.id),
    ).resolves.toMatchObject({
      conversationId: CONVERSATION_ID,
      authoritySnapshotJson: {
        toolName: 'AgentDelegation',
        maxDepth: 1,
      },
      privateCorrelationJson: {
        targetAgentId: TARGET_AGENT_ID,
        workspaceFolder: TARGET_AGENT_FOLDER,
      },
    });
  });

  it('persists a delegated task failure as an immutable terminal result across repository instances', async () => {
    const service = new AsyncCommandTaskService(
      runtime.repositories.asyncTasks,
      { run: async () => ({}) },
    );
    const started = await service.startDelegatedAgent({
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      conversationId: CONVERSATION_ID,
      objective: 'Review durable delegation',
      targetAgentId: TARGET_AGENT_ID,
      authorityToolName: 'AgentDelegation',
      workspaceFolder: TARGET_AGENT_FOLDER,
      run: async () => ({
        outputSummary: 'Reviewed two sources.',
        errorSummary: 'Delegated review failed.',
        failure: {
          type: 'execution',
          attemptedAction: 'Review durable delegation',
          partialResult: 'Reviewed two sources.',
        },
      }),
    });

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.message);
    await expect(started.completion.wait(5_000)).resolves.toMatchObject({
      taskId: started.task.id,
      status: 'failed',
    });

    const freshRepository = new PostgresAsyncTaskRepository(runtime.service.db);
    const freshService = new AsyncCommandTaskService(freshRepository, {
      run: async () => ({}),
    });
    const persisted = await freshRepository.getTask(started.task.id);
    expect(persisted).toMatchObject({
      status: 'failed',
      terminalAt: expect.any(String),
      privateCorrelationJson: {
        targetAgentId: TARGET_AGENT_ID,
        failure: {
          type: 'execution',
          attemptedAction: 'Review durable delegation',
          partialResult: 'Reviewed two sources.',
        },
      },
    });
    await expect(
      freshService.getScoped({
        taskId: started.task.id,
        appId: DEFAULT_APP_ID,
        agentId: DEFAULT_AGENT_ID,
        conversationId: CONVERSATION_ID,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      failure: {
        type: 'execution',
        attemptedAction: 'Review durable delegation',
        partialResult: 'Reviewed two sources.',
      },
      allowedActions: ['get', 'list'],
    });
    expect(persisted).not.toBeNull();
    if (!persisted) return;
    await expect(
      freshRepository.transitionTask({
        taskId: persisted.id,
        leaseToken: persisted.leaseToken,
        fencingVersion: persisted.fencingVersion,
        status: 'completed',
        now: '2026-07-21T00:00:01.000Z',
        terminalAt: '2026-07-21T00:00:01.000Z',
      }),
    ).resolves.toBeNull();
  });
});
