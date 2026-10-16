import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PostgresIntegrationRuntime } from '../harness/postgres-integration-runtime.js';
import type { createJobBackgroundHarness } from '../harness/job-background-work.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

maybeDescribe('job-background-work', () => {
  let runtime: PostgresIntegrationRuntime;
  let harness: Awaited<ReturnType<typeof createJobBackgroundHarness>>;
  let home: string;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-job-background-e2e-'));
    vi.stubEnv('GANTRY_HOME', home);
    vi.stubEnv(
      'SECRET_ENCRYPTION_KEY',
      Buffer.alloc(32, 32).toString('base64'),
    );
    vi.resetModules();
    const { createPostgresIntegrationRuntime } =
      await import('../harness/postgres-integration-runtime.js');
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'job_background_e2e',
    });
    const { createJobBackgroundHarness } =
      await import('../harness/job-background-work.js');
    harness = await createJobBackgroundHarness(runtime);
  }, 60_000);

  afterAll(async () => {
    try {
      try {
        await harness?.cleanup();
      } finally {
        await runtime?.cleanup();
      }
    } finally {
      vi.unstubAllEnvs();
      if (home) fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('shows a scheduled background command outcome in the job run and terminal notification', async () => {
    const run = await harness.dispatch('job:e2e:background', async (input) => {
      const id = await harness.invoke(input, 'async_run_command', {
        command: 'printf background-command-completed',
      });
      expect(id).toBeTruthy();
      return (await harness.waitForTask(id!)).outputSummary!;
    });
    expect(run).toMatchObject({
      status: 'completed',
      result_summary: 'background-command-completed',
    });
    expect(harness.sent).toEqual(
      expect.arrayContaining([
        expect.stringContaining('background-command-completed'),
      ]),
    );
    expect(await harness.tasksForJob(run.job_id)).toEqual([
      expect.objectContaining({
        status: 'completed',
        parent_run_id: run.run_id,
        parent_job_id: run.job_id,
        output_summary: 'background-command-completed',
      }),
    ]);
  }, 30_000);
});
