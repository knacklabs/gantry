import type { JobRun } from '../../../../domain/repositories/domain-types.js';
import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  DEFAULT_LLM_PROFILE_ID,
} from './canonical-graph-repository.postgres.js';

const JOB_RUN_SHORT_ID_UNIQUE_CONSTRAINT = 'idx_agent_runs_job_short_id_unique';
const JOB_RUN_INSERT_MAX_ATTEMPTS = 5;

type CanonicalExecutor =
  CanonicalDb | Parameters<Parameters<CanonicalDb['transaction']>[0]>[0];

export async function insertCanonicalJobRun(input: {
  run: JobRun;
  executor: CanonicalExecutor;
  graph: { agentId: string; configVersionId: string };
  nextRunShortId: (jobId: string) => Promise<number>;
}): Promise<boolean> {
  const { run, executor, graph } = input;
  const explicitShortId = run.short_id !== null && run.short_id !== undefined;
  const maxAttempts =
    run.job_id && !explicitShortId ? JOB_RUN_INSERT_MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const shortId = explicitShortId
      ? run.short_id
      : run.job_id
        ? await input.nextRunShortId(run.job_id)
        : null;
    run.short_id = shortId ?? null;
    try {
      const rows = await executor
        .insert(pgSchema.agentRunsPostgres)
        .values({
          id: run.run_id,
          shortId: run.short_id,
          appId: CANONICAL_APP_ID,
          agentId: graph.agentId,
          configVersionId: graph.configVersionId,
          jobId: run.job_id,
          llmProfileId: DEFAULT_LLM_PROFILE_ID,
          executionProviderId: run.execution_provider_id,
          providerRunId: run.provider_run_id ?? null,
          providerSessionId: run.provider_session_id ?? null,
          workerId: run.worker_id ?? null,
          leaseOwner: run.lease_owner ?? null,
          leaseExpiresAt: run.lease_expires_at ?? null,
          cause: 'job',
          status: run.status,
          createdAt: run.scheduled_for || run.started_at,
          startedAt: run.started_at,
          endedAt: run.ended_at,
          resultSummary: run.result_summary,
          errorSummary: run.error_summary,
          notifiedAt: run.notified_at,
        })
        .returning({ id: pgSchema.agentRunsPostgres.id });
      return rows.length > 0;
    } catch (err) {
      if (
        run.job_id &&
        !explicitShortId &&
        isJobRunShortIdUniqueViolation(err) &&
        attempt < maxAttempts
      ) {
        run.short_id = null;
        continue;
      }
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }
  return false;
}

function uniqueViolationConstraint(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const record = err as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (record.code === '23505') {
    return typeof record.constraint === 'string' ? record.constraint : '';
  }
  return uniqueViolationConstraint(record.cause);
}

function isJobRunShortIdUniqueViolation(err: unknown): boolean {
  return uniqueViolationConstraint(err) === JOB_RUN_SHORT_ID_UNIQUE_CONSTRAINT;
}

function isUniqueViolation(err: unknown): boolean {
  return uniqueViolationConstraint(err) !== null;
}
