import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import { nowIso } from '@core/shared/time/datetime.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const tsxBin = path.join(repoRoot, 'node_modules/.bin/tsx');
const workerScript = path.join(here, 'fixtures', 'worker-claim-process.ts');

interface WorkerOutcome {
  marker: 'CHAOS_WORKER';
  workerInstanceId?: string;
  claimed?: boolean;
  fencingVersion?: number;
  completed?: boolean;
  error?: string;
}

/**
 * Spawn the worker fixture as a real, separate OS process. Returns the parsed
 * single-line JSON outcome (plus raw output for diagnostics).
 */
function spawnWorker(env: Record<string, string>): Promise<{
  outcome: WorkerOutcome | null;
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [workerScript], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse()
        .find((l) => l.includes('"marker":"CHAOS_WORKER"'));
      let outcome: WorkerOutcome | null = null;
      if (line) {
        try {
          outcome = JSON.parse(line) as WorkerOutcome;
        } catch {
          outcome = null;
        }
      }
      resolve({ outcome, code, stdout, stderr });
    });
  });
}

function makeJob(id: string): JobUpsertInput {
  const now = nowIso();
  return {
    id,
    name: `Job ${id}`,
    prompt: 'Two-process claim e2e',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: null,
    execution_context: {
      conversationJid: 'tg:two-process-claim',
      threadId: null,
      workspaceKey: 'scheduler_agent',
      sessionId: null,
    },
    workspace_key: 'scheduler_agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: true,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
  } satisfies JobUpsertInput;
}

maybeDescribe('two-process worker claim protocol (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  const jobId = 'job-two-process-claim';
  const runId = 'run-two-process-claim';

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'two_proc_claim',
    });
    // Two separate worker instances compete for one run.
    await runtime.repositories.workerCoordination.registerWorker({
      id: 'proc-worker-a',
      bootNonce: 'nonce-a',
    });
    await runtime.repositories.workerCoordination.registerWorker({
      id: 'proc-worker-b',
      bootNonce: 'nonce-b',
    });
    // Seed only the runnable job. The run row itself is created transactionally
    // by the winning worker's claimDueJobRunStart (the production scheduler claim
    // path), so the run never exists without a confirmed claim.
    await runtime.ops.upsertJob(makeJob(jobId));
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it(
    'two separate OS worker processes race the claim; exactly one wins and ' +
      'durably completes the run',
    async () => {
      const databaseUrl = process.env.GANTRY_TEST_DATABASE_URL ?? '';
      const schema = runtime.schemaName;
      // Shared wall-clock barrier so both processes attempt the claim in the same
      // window when timing permits — giving genuine concurrent-claim coverage on
      // top of the protocol's own guarantee. Correctness does NOT depend on the
      // barrier: claimDueJobRunStart refuses the loser whether it arrives while
      // the winner's lease is active (claimed-elsewhere) or after the winner
      // finished (terminal run row), so the assertions hold at any interleaving.
      const startAtMs = String(Date.now() + 1_500);

      const baseEnv = {
        GANTRY_TEST_DATABASE_URL: databaseUrl,
        CHAOS_SCHEMA: schema,
        CHAOS_RUN_ID: runId,
        CHAOS_JOB_ID: jobId,
        CHAOS_START_AT_MS: startAtMs,
      };

      const [a, b] = await Promise.all([
        spawnWorker({ ...baseEnv, CHAOS_WORKER_INSTANCE_ID: 'proc-worker-a' }),
        spawnWorker({ ...baseEnv, CHAOS_WORKER_INSTANCE_ID: 'proc-worker-b' }),
      ]);

      // Both processes exited cleanly with a parseable outcome.
      expect(a.code, `worker A stderr:\n${a.stderr}`).toBe(0);
      expect(b.code, `worker B stderr:\n${b.stderr}`).toBe(0);
      expect(a.outcome, `worker A stdout:\n${a.stdout}`).not.toBeNull();
      expect(b.outcome, `worker B stdout:\n${b.stdout}`).not.toBeNull();
      expect(a.outcome?.error).toBeUndefined();
      expect(b.outcome?.error).toBeUndefined();

      // Exactly one process claimed the run; the other was refused.
      const claims = [a.outcome, b.outcome].filter((o) => o?.claimed === true);
      const refusals = [a.outcome, b.outcome].filter(
        (o) => o?.claimed === false,
      );
      expect(claims).toHaveLength(1);
      expect(refusals).toHaveLength(1);

      // The winner held fencing version 1 (first claim on a fresh run) and the
      // lease-fenced terminal write succeeded.
      expect(claims[0]?.fencingVersion).toBe(1);
      expect(claims[0]?.completed).toBe(true);

      // Terminal state is DURABLY visible from the parent process: the run row is
      // `completed` and stamped by the winning worker.
      const finalRun = await runtime.ops.getJobRunById(runId);
      expect(finalRun?.status).toBe('completed');
      expect(finalRun?.result_summary).toBe(
        `completed by ${claims[0]?.workerInstanceId}`,
      );

      // The active lease is settled — no live lease lingers after completion.
      const activeLease =
        await runtime.repositories.workerCoordination.getActiveRunLease({
          runId,
        });
      expect(activeLease).toBeNull();
    },
    60_000,
  );
});
