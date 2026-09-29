import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('storage readiness', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'storage_readiness',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('reports a table whose primary key lacks an identity generator', async () => {
    expect((await runtime.service.healthCheck()).runtimeEvents).toBe(true);

    await runtime.service.pool.query(
      'ALTER TABLE message_parts ALTER COLUMN id DROP IDENTITY',
    );

    const capabilities = await runtime.service.healthCheck();
    expect(capabilities.runtimeEvents).toBe(false);
    expect(capabilities.runtimeEventsReason).toContain(
      'message_parts.id identity/default is missing',
    );
  });
});
