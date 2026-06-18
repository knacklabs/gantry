import type {
  JobEvent,
  JobRun,
} from '../../../../domain/repositories/domain-types.js';
import type { ExecutionProviderId } from '../../../../domain/sessions/sessions.js';
import { engineForExecutionProviderId } from '../../../../shared/model-execution-route.js';
import { parseJson } from '../repositories/canonical-graph-repository.postgres.js';
// prettier-ignore
import type { CanonicalJobEventRecord, CanonicalRunRecord } from '../repositories/canonical-job-repository.postgres.js';

// Canonical run/event row -> domain DTO mappers. Extracted from
// canonical-job-ops-service.ts to keep that service under its file budget; pure
// functions with no service state. `agent_engine` is the inherited engine for a
// run, derived read-only from the diagnostic executionProviderId.
export function mapCanonicalRunRecord(row: CanonicalRunRecord): JobRun {
  return {
    run_id: row.id,
    short_id: row.shortId,
    job_id: row.jobId || '',
    execution_provider_id: row.executionProviderId as ExecutionProviderId,
    agent_engine: engineForExecutionProviderId(row.executionProviderId) ?? null,
    provider_run_id: row.providerRunId,
    provider_session_id: row.providerSessionId,
    worker_id: row.workerId,
    lease_owner: row.leaseOwner,
    lease_expires_at: row.leaseExpiresAt,
    scheduled_for: row.createdAt,
    started_at: row.startedAt || row.createdAt,
    ended_at: row.endedAt,
    status: row.status as JobRun['status'],
    result_summary: row.resultSummary,
    error_summary: row.errorSummary,
    retry_count: 0,
    notified_at: row.notifiedAt,
  };
}

export function mapCanonicalJobEventRecord(
  row: CanonicalJobEventRecord,
  index: number,
  fallbackJobId?: string,
): JobEvent {
  const payload = parseJson<Partial<JobEvent>>(row.payloadJson, {});
  return {
    id: Number(row.id) || index + 1,
    job_id: row.jobId || payload.job_id || fallbackJobId || '',
    run_id: row.runId,
    event_type: row.type,
    payload: payload.payload ?? row.payloadJson,
    created_at: row.createdAt,
  };
}
