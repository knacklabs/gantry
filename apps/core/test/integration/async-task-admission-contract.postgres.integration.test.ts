import { afterAll, beforeAll, describe, it } from 'vitest';

import { PostgresAsyncTaskRepository } from '@core/adapters/storage/postgres/repositories/async-task-repository.postgres.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';

import { expectAsyncTaskRepositoryContract } from '../harness/async-task-repository-contract.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const appId = DEFAULT_APP_ID as AppId;
const additionalAgentIds = [
  'agent:async-task-contract:1',
  'agent:async-task-contract:2',
  'agent:async-task-contract:3',
] as const satisfies readonly AgentId[];
const now = '2026-07-28T00:00:00.000Z';

maybeDescribe('Postgres async task repository contract', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'async_task_admission_contract',
    });
    await Promise.all(
      additionalAgentIds.map((agentId, index) =>
        runtime.repositories.agents.saveAgent({
          id: agentId,
          appId,
          name: `Async Task Contract Agent ${index + 1}`,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('admits and claims atomically under concurrency', async () => {
    const repository = new PostgresAsyncTaskRepository(runtime.service.db);

    await expectAsyncTaskRepositoryContract({
      repository,
      idPrefix: 'postgres-async-task-contract',
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      additionalAgentIds: [...additionalAgentIds],
      conversationId: 'conversation:async-task-contract',
      now,
      maxBacklogPerAgent: 3,
      maxBacklogPerApp: 3,
      maxRunningPerAgent: 2,
      maxRunningPerApp: 3,
    });
  });
});
