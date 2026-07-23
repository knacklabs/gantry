import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresStorageService } from '@core/adapters/storage/postgres/storage-service.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'default';
const AGENT_ID = 'agent:main_agent';

// Matrix §8 write → recall → subject-boundary chain against the real
// AppMemoryService + test Postgres. Recall uses the hermetic subject-scoped
// fetch path (AppMemoryService.list → visibleSubjectFilters); the test
// runtime disables embeddings (runtime-env.ts settings: provider `disabled`),
// so embedding-dependent hybrid recall is intentionally NOT exercised here.
maybeDescribe('memory write, recall, and subject boundary (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let memory: AppMemoryService;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'memory_boundary',
    });
    memory = new AppMemoryService(runtime.service.db);
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('recalls a person-scoped memory for its subject only, across a service reload', async () => {
    const saved = await memory.save({
      appId: APP_ID,
      agentId: AGENT_ID,
      userId: 'user:alice',
      subjectType: 'user',
      kind: 'fact',
      key: 'preferred-report-day',
      value: 'Alice wants the weekly report on Thursdays.',
      source: 'integration-test',
      confidence: 1,
    });
    expect(saved).toMatchObject({
      agentId: AGENT_ID,
      subjectType: 'user',
      userId: 'user:alice',
      key: 'preferred-report-day',
    });

    // Recall for subject A returns the memory.
    const recalledForAlice = await memory.list({
      appId: APP_ID,
      agentId: AGENT_ID,
      userId: 'user:alice',
    });
    expect(recalledForAlice.map((item) => item.id)).toContain(saved.id);

    // Recall for subject B (different person) does NOT cross the boundary.
    const recalledForBob = await memory.list({
      appId: APP_ID,
      agentId: AGENT_ID,
      userId: 'user:bob',
    });
    expect(recalledForBob.map((item) => item.id)).not.toContain(saved.id);

    // A group-scoped recall context (no user subject) does not see the
    // person-scoped memory either.
    const recalledForGroup = await memory.list({
      appId: APP_ID,
      agentId: AGENT_ID,
      groupId: 'team-room',
    });
    expect(recalledForGroup.map((item) => item.id)).not.toContain(saved.id);

    // Restart simulation: fresh storage service + fresh memory service over
    // the same database — subject A still recalls, subject B still does not.
    const fresh = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL!,
      runtime.schemaName,
    );
    try {
      const reloadedMemory = new AppMemoryService(fresh.db);
      const recalledAfterRestart = await reloadedMemory.list({
        appId: APP_ID,
        agentId: AGENT_ID,
        userId: 'user:alice',
      });
      expect(recalledAfterRestart.map((item) => item.id)).toContain(saved.id);
      expect(
        recalledAfterRestart.find((item) => item.id === saved.id)?.value,
      ).toBe('Alice wants the weekly report on Thursdays.');
      const bobAfterRestart = await reloadedMemory.list({
        appId: APP_ID,
        agentId: AGENT_ID,
        userId: 'user:bob',
      });
      expect(bobAfterRestart.map((item) => item.id)).not.toContain(saved.id);
    } finally {
      await fresh.close();
    }
  });
});
