import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresStorageService,
  postgresMigrationsFolder,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import {
  DEFAULT_AGENT_CONFIG_VERSION_ID,
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
  seedDefaultRuntimeData,
} from '@core/adapters/storage/postgres/seeds.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

maybeDescribe('background task link migration', () => {
  let service: PostgresStorageService;
  let schemaName: string;
  let migrationFolder: string;

  beforeAll(async () => {
    schemaName = `task_links_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    migrationFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'task-links-'));
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(postgresMigrationsFolder, 'meta/_journal.json'),
        'utf8',
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };
    // Build the last shipped schema, then let the production migrator upgrade it.
    journal.entries = journal.entries.filter(({ idx }) => idx <= 156);
    fs.mkdirSync(path.join(migrationFolder, 'meta'));
    fs.writeFileSync(
      path.join(migrationFolder, 'meta/_journal.json'),
      JSON.stringify(journal),
    );
    for (const { tag } of journal.entries) {
      fs.copyFileSync(
        path.join(postgresMigrationsFolder, `${tag}.sql`),
        path.join(migrationFolder, `${tag}.sql`),
      );
    }
    await service.pool.query(
      `CREATE SCHEMA ${quotePostgresIdentifier(schemaName)}`,
    );
    await migrate(service.db, {
      migrationsFolder: migrationFolder,
      migrationsSchema: schemaName,
    });
    await seedDefaultRuntimeData(service.db);
  });

  afterAll(async () => {
    if (service) {
      try {
        await service.pool.query(
          `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
        );
      } finally {
        await service.close();
      }
    }
    if (migrationFolder)
      fs.rmSync(migrationFolder, { recursive: true, force: true });
  });

  it('carries each available link forward without replacing independently saved links and removes duplicate storage', async () => {
    for (const jobId of ['source-job', 'own-job']) {
      await service.pool.query(
        `INSERT INTO jobs
          (id, app_id, created_by_actor_id, created_by_source, name, prompt, schedule_json, created_at, updated_at)
         VALUES ($1, $2, 'owner', 'test', 'Background work', 'Run work', '{}', now(), now())`,
        [jobId, DEFAULT_APP_ID],
      );
    }
    for (const runId of ['source-run', 'own-run']) {
      await service.pool.query(
        `INSERT INTO agent_runs
          (id, app_id, agent_id, config_version_id, llm_profile_id, execution_provider_id, cause, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'anthropic:claude-agent-sdk', 'job', 'succeeded', now())`,
        [
          runId,
          DEFAULT_APP_ID,
          DEFAULT_AGENT_ID,
          DEFAULT_AGENT_CONFIG_VERSION_ID,
          DEFAULT_LLM_PROFILE_ID,
        ],
      );
    }
    await service.pool.query(
      `INSERT INTO job_runs (id, app_id, job_id, agent_run_id, status, created_at, updated_at)
       VALUES ('with-run', $1, 'source-job', 'source-run', 'completed', now(), now()),
              ('without-run', $1, 'source-job', NULL, 'completed', now(), now())`,
      [DEFAULT_APP_ID],
    );
    for (const [id, oldLink, runId, jobId] of [
      ['carried-run', 'with-run', null, null],
      ['carried-job', 'without-run', null, null],
      ['own-links', 'with-run', 'own-run', 'own-job'],
      ['own-run', 'with-run', 'own-run', null],
      ['own-job', 'with-run', null, 'own-job'],
    ]) {
      await service.pool.query(
        `INSERT INTO agent_async_tasks
          (id, app_id, agent_id, parent_job_run_id, parent_run_id, parent_job_id,
           kind, status, admission_class, authority_snapshot_json, private_correlation_json,
           lease_token, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'async_command', 'completed', 'task', '{}', '{}', 'lease', now(), now())`,
        [id, DEFAULT_APP_ID, DEFAULT_AGENT_ID, oldLink, runId, jobId],
      );
    }

    await service.migrate();

    const tasks = await service.pool.query<{
      id: string;
      parent_run_id: string | null;
      parent_job_id: string | null;
    }>(
      'SELECT id, parent_run_id, parent_job_id FROM agent_async_tasks ORDER BY id',
    );
    expect(tasks.rows).toEqual([
      { id: 'carried-job', parent_run_id: null, parent_job_id: 'source-job' },
      {
        id: 'carried-run',
        parent_run_id: 'source-run',
        parent_job_id: 'source-job',
      },
      { id: 'own-job', parent_run_id: 'source-run', parent_job_id: 'own-job' },
      { id: 'own-links', parent_run_id: 'own-run', parent_job_id: 'own-job' },
      { id: 'own-run', parent_run_id: 'own-run', parent_job_id: 'source-job' },
    ]);
    const removed = await service.pool.query<{
      table_exists: boolean;
      column_exists: boolean;
    }>(
      `SELECT
         to_regclass(format('%I.job_runs', $1::text)) IS NOT NULL AS table_exists,
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name = 'agent_async_tasks'
                   AND column_name = 'parent_job_run_id') AS column_exists`,
      [schemaName],
    );
    expect(removed.rows[0]).toEqual({
      table_exists: false,
      column_exists: false,
    });
  });
});
