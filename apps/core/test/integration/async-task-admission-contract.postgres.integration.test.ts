import { afterAll, beforeAll, describe, it } from 'vitest';

import { PostgresAsyncTaskRepository } from '@core/adapters/storage/postgres/repositories/async-task-repository.postgres.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';

import { expectAsyncTaskRepositoryContract } from '../harness/async-task-repository-contract.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('Postgres async task repository contract', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'async_task_admission_contract',
    });
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
      conversationId: 'conversation:async-task-contract',
    });
  });
});
