import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDomainRepositories,
  type PostgresDomainRepositoryBundle,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import {
  DEFAULT_AGENT_CONFIG_VERSION_ID,
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { AgentRunId } from '@core/domain/events/events.js';
import type { ExecutionProviderId } from '@core/domain/sessions/sessions.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

maybeDescribe('Postgres activity projection', () => {
  let service: PostgresStorageService;
  let repositories: PostgresDomainRepositoryBundle;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `activity_test_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    await service.migrate();
    repositories = createPostgresDomainRepositories(service.db, service.pool);
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    await service.pool.query(
      `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
    );
    await service.close();
  });

  it('lists recent app-owned runs in stable order', async () => {
    for (let index = 0; index < 52; index += 1) {
      const suffix = String(index).padStart(2, '0');
      await repositories.agentRuns.saveAgentRun({
        id: `agent-run:activity:${suffix}` as AgentRunId,
        appId: DEFAULT_APP_ID as never,
        agentId: DEFAULT_AGENT_ID as never,
        configVersionId: DEFAULT_AGENT_CONFIG_VERSION_ID as never,
        llmProfileId: DEFAULT_LLM_PROFILE_ID as never,
        executionProviderId:
          'anthropic:claude-agent-sdk' as ExecutionProviderId,
        permissionDecisionIds: [],
        cause: 'message',
        status: 'completed',
        createdAt: '2026-08-12T10:00:00.000Z' as never,
        startedAt: '2026-08-12T10:00:01.000Z' as never,
        endedAt: '2026-08-12T10:00:02.000Z' as never,
      });
    }

    const runs = await repositories.agentRuns.listRecentAgentRuns(
      DEFAULT_APP_ID as never,
    );

    expect(runs).toHaveLength(50);
    expect(runs.map((run) => run.id)).toEqual(
      Array.from(
        { length: 50 },
        (_, offset) =>
          `agent-run:activity:${String(51 - offset).padStart(2, '0')}`,
      ),
    );
    await expect(
      repositories.agentRuns.getAgentRunForApp({
        appId: 'other-app' as never,
        runId: 'agent-run:activity:51' as AgentRunId,
      }),
    ).resolves.toBeNull();
  });
});
