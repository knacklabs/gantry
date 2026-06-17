import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import { buildDeepAgentStartupDiagnosticEvent } from '@core/adapters/llm/deepagents-langchain/runner/startup-diagnostic.js';
import { runnerStartupTimingRuntimeEvent } from '@core/adapters/llm/anthropic-claude-agent/runner/runner-startup-diagnostic.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  AgentRunId,
  RuntimeEventPublishInput,
} from '@core/domain/events/events.js';
import type {
  AgentSessionId,
  ExecutionProviderId,
  ProviderSessionId,
} from '@core/domain/sessions/sessions.js';
import { DEEPAGENTS_ENGINE } from '@core/shared/agent-engine.js';
import { buildRunnerHostStartupDiagnosticEvent } from '@core/runtime/agent-spawn-startup-diagnostic.js';
import { publishRunnerProcessStartupDiagnostic } from '@core/runtime/agent-spawn-process-diagnostic.js';
import type { RunnerProcessSpec } from '@core/runtime/agent-spawn-types.js';

import {
  LIVE_LATENCY_BENCHMARK_METRIC_NAMES,
  createPostgresLiveLatencyHotPathObserver,
  loadLiveLatencyStartupDiagnosticsFromRuntimeEvents,
  runSyntheticLiveLatencyBenchmark,
} from '../harness/live-latency-benchmark.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const BENCHMARK_RUN_ID = 'live-latency-benchmark-itest';
const BENCHMARK_PROVIDER_CONNECTION_ID =
  'provider-connection:live-latency-benchmark';
const BENCHMARK_CONVERSATION_ID = 'conversation:live-latency-benchmark';
const BENCHMARK_EXECUTION_PROVIDER_ID =
  'anthropic:claude-agent-sdk' as ExecutionProviderId;
const HISTORICAL_ADMISSION_COUNT = 100_000;
const HISTORICAL_TERMINAL_TURN_COUNT = 100_000;
const HISTORICAL_AGENT_SESSION_COUNT = 50_000;
const HISTORICAL_PROVIDER_SESSION_COUNT = 100_000;
const LIVE_ADMISSION_EXPLAIN_RUN_ID = 'live-admission-claim-explain-itest';
const LIVE_ADMISSION_EXPLAIN_LIMIT = 25;
const LIVE_ADMISSION_EXPLAIN_CANDIDATE_LIMIT = LIVE_ADMISSION_EXPLAIN_LIMIT * 4;
const PROVIDER_SESSION_EXPLAIN_RUN_ID =
  'provider-session-resume-write-explain-itest';
const PROVIDER_SESSION_EXPLAIN_ARTIFACT_NAME = 'provider-session-plan.json';
const PROVIDER_SESSION_METRICS_ARTIFACT_NAME =
  'provider-session-300-metrics.json';
const ROWS_SCANNED_TO_RETURNED_RATIO_GATE = 20;
const LIVE_ADMISSION_EXPLAIN_ARTIFACT_NAME = 'live-admission-claim-plan.json';
const LIVE_ADMISSION_EXPECTED_BRANCH_INDEXES = [
  'idx_live_admission_work_items_queued_fifo',
  'idx_live_admission_work_items_deferred_due',
  'idx_live_admission_work_items_deferred_null_fifo',
  'idx_live_admission_work_items_claimed_expired',
] as const;

type ExplainPlanNode = Record<string, unknown> & {
  Plans?: ExplainPlanNode[];
};

interface ScanNodeEvidence {
  nodeType: string;
  relationName?: string;
  indexName?: string;
  actualRows?: number;
  actualLoops?: number;
  rowsRemovedByFilter?: number;
  buffers: Record<string, number>;
}

interface PlanNodeEvidence {
  nodeType: string;
  actualRows?: number;
  actualLoops?: number;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function itemRunIdsByItemId(
  benchmarkRunId: string,
  concurrency: number,
): Map<string, string> {
  return new Map(
    Array.from({ length: concurrency }, (_, index) => [
      `${benchmarkRunId}:admission:${index}`,
      `agent-run:${benchmarkRunId}:${index}`,
    ]),
  );
}

function benchmarkSampleIndex(sampleId: string): number {
  const raw = sampleId.slice(sampleId.lastIndexOf(':') + 1);
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Unexpected benchmark sample id: ${sampleId}`);
  }
  return index;
}

function providerReadAgentSessionId(index: number): AgentSessionId {
  return `${BENCHMARK_RUN_ID}:provider-read-agent-session:${index}` as AgentSessionId;
}

function providerReadSessionId(
  index: number,
  suffix = 'current',
): ProviderSessionId {
  return `${BENCHMARK_RUN_ID}:provider-read-session:${index}:${suffix}` as ProviderSessionId;
}

function providerWriteSessionId(index: number, suffix: string): string {
  return `provider-session:live-latency-benchmark:${suffix}:${index}`;
}

async function seedHistoricalNonBlockingLiveAdmissionVolume(
  runtime: PostgresIntegrationRuntime,
  appId: AppId,
): Promise<void> {
  await runtime.service.pool.query(
    `INSERT INTO live_admission_work_items (
       id,
       app_id,
       agent_id,
       agent_session_id,
       conversation_id,
       thread_id,
       queue_jid,
       message_id,
       message_cursor,
       sender_user_id,
       sender_display_name,
       idempotency_key,
       state,
       source_kind,
       trigger_decision_json,
       claim_worker_instance_id,
       claim_token,
       claim_expires_at,
       fencing_version,
       retry_count,
       defer_until,
       deferred_reason,
       created_at,
       updated_at,
       claimed_at,
       ended_at
     )
     SELECT
       'historical-admission:' || n,
       $2,
       $3,
       'historical-session:' || n,
       'app:live-latency-benchmark:' || (n % 300),
       NULL,
       'app:live-latency-benchmark:' || (n % 300),
       'historical-message:' || n,
       '2999-01-01T00:00:00.000Z::historical::' || n,
       'historical-user:' || n,
       'Historical User',
       'historical-delivery:' || n,
       CASE n % 5
         WHEN 0 THEN 'deferred'
         WHEN 1 THEN 'claimed'
         WHEN 2 THEN 'completed'
         WHEN 3 THEN 'failed'
         ELSE 'canceled'
       END,
       'message',
       '{}'::jsonb,
       CASE WHEN n % 5 = 1 THEN 'historical-worker:' || n ELSE NULL END,
       CASE WHEN n % 5 = 1 THEN 'historical-token:' || n ELSE NULL END,
       CASE WHEN n % 5 = 1 THEN '2999-01-01T00:00:00.000Z'::timestamptz ELSE NULL END,
       CASE WHEN n % 5 = 1 THEN 1 ELSE 0 END,
       CASE WHEN n % 5 = 1 THEN 1 ELSE 0 END,
       CASE WHEN n % 5 = 0 THEN '2999-01-01T00:00:00.000Z'::timestamptz ELSE NULL END,
       CASE WHEN n % 5 = 0 THEN 'retry' ELSE NULL END,
       CASE WHEN n % 5 IN (0, 1) THEN '2999-01-01T00:00:00.000Z'::timestamptz ELSE '2026-01-01T00:00:00.000Z'::timestamptz END,
       CASE WHEN n % 5 IN (0, 1) THEN '2999-01-01T00:00:00.000Z'::timestamptz ELSE '2026-01-01T00:00:00.000Z'::timestamptz END,
       CASE WHEN n % 5 = 1 THEN '2999-01-01T00:00:00.000Z'::timestamptz ELSE NULL END,
       CASE WHEN n % 5 IN (2, 3, 4) THEN '2026-01-01T00:00:00.000Z'::timestamptz ELSE NULL END
     FROM generate_series(1, $1::integer) AS series(n)`,
    [HISTORICAL_ADMISSION_COUNT, appId, DEFAULT_AGENT_ID],
  );
}

async function seedHistoricalTerminalLiveTurns(
  runtime: PostgresIntegrationRuntime,
  appId: AppId,
): Promise<void> {
  await runtime.service.pool.query(
    `INSERT INTO live_turns (
       id,
       scope_key,
       app_id,
       agent_session_id,
       conversation_id,
       thread_id,
       run_id,
       state,
       pending_message_json,
       stop_alias_jids_json,
       required_continuation_user_id,
       retry_count,
       next_command_seq,
       worker_instance_id,
       lease_token,
       fencing_version,
       created_at,
       updated_at,
       ended_at
     )
     SELECT
       'historical-live-turn:' || n,
       'historical-scope:' || (n % 300),
       $2,
       'historical-session:' || n,
       'app:live-latency-benchmark:' || (n % 300),
       NULL,
       NULL,
       CASE n % 3
         WHEN 0 THEN 'completed'
         WHEN 1 THEN 'failed'
         ELSE 'timed_out'
       END,
       NULL,
       '[]'::jsonb,
       NULL,
       0,
       1,
       NULL,
       NULL,
       NULL,
       '2026-01-01T00:00:00.000Z'::timestamptz,
       '2026-01-01T00:00:00.000Z'::timestamptz,
       '2026-01-01T00:00:00.000Z'::timestamptz
     FROM generate_series(1, $1::integer) AS series(n)`,
    [HISTORICAL_TERMINAL_TURN_COUNT, appId],
  );
}

async function seedProviderSessionRowVolume(
  runtime: PostgresIntegrationRuntime,
  appId: AppId,
): Promise<void> {
  await runtime.service.pool.query(
    `INSERT INTO agent_sessions (
       id, app_id, agent_id, conversation_id, thread_id, job_id, user_id,
       scope_key, latest_provider_session_id, status, model_override,
       created_at, updated_at, reset_at
     )
     SELECT
       'historical-provider-agent-session:' || n,
       $2,
       $3,
       NULL,
       NULL,
       NULL,
       'historical-provider-user:' || n,
       'historical-provider-scope:' || n,
       NULL,
       CASE n % 4
         WHEN 0 THEN 'active'
         WHEN 1 THEN 'active'
         WHEN 2 THEN 'reset'
         ELSE 'archived'
       END,
       NULL,
       '2026-01-01T00:00:00.000Z'::timestamptz + (n || ' seconds')::interval,
       '2026-01-01T00:00:00.000Z'::timestamptz + (n || ' seconds')::interval,
       CASE WHEN n % 4 = 2 THEN '2026-01-02T00:00:00.000Z'::timestamptz ELSE NULL END
     FROM generate_series(1, $1::integer) AS series(n)
     ON CONFLICT (id) DO NOTHING`,
    [HISTORICAL_AGENT_SESSION_COUNT, appId, DEFAULT_AGENT_ID],
  );

  await runtime.service.pool.query(
    `INSERT INTO provider_sessions (
       id, app_id, agent_session_id, provider, external_session_id,
       provider_ref_json, metadata_json, status, created_at, updated_at
     )
     SELECT
       'historical-provider-session:' || n,
       $2,
       'historical-provider-agent-session:' ||
         (((n - 1) % $1::integer) + 1),
       CASE WHEN n % 2 = 0 THEN $3 ELSE $4 END,
       'historical-provider-external:' || n,
       jsonb_build_object(
         'kind', 'provider_session',
         'value', (CASE WHEN n % 2 = 0 THEN $3 ELSE $4 END) || ':historical-provider-external:' || n,
         'provider', CASE WHEN n % 2 = 0 THEN $3 ELSE $4 END,
         'externalSessionId', 'historical-provider-external:' || n
       ),
       jsonb_build_object('seed', 'historical-provider-session-volume'),
       CASE n % 5
         WHEN 0 THEN 'expired'
         WHEN 1 THEN 'reset'
         ELSE 'active'
       END,
       '2026-01-01T00:00:00.000Z'::timestamptz + (n || ' seconds')::interval,
       '2026-01-01T00:00:00.000Z'::timestamptz + (n || ' seconds')::interval
     FROM generate_series(1, $5::integer) AS series(n)
     ON CONFLICT (id) DO NOTHING`,
    [
      HISTORICAL_AGENT_SESSION_COUNT,
      appId,
      BENCHMARK_EXECUTION_PROVIDER_ID,
      'deepagents:langchain',
      HISTORICAL_PROVIDER_SESSION_COUNT,
    ],
  );

  await runtime.service.pool.query(
    `INSERT INTO agent_sessions (
       id, app_id, agent_id, conversation_id, thread_id, job_id, user_id,
       scope_key, latest_provider_session_id, status, model_override,
       created_at, updated_at, reset_at
     )
     SELECT
       $4 || ':provider-read-agent-session:' || n,
       $1,
       $2,
       NULL,
       NULL,
       NULL,
       'provider-read-user:' || n,
       'provider-read-scope:' || n,
       $4 || ':provider-read-session:' || n || ':current',
       'active',
       NULL,
       '2026-06-17T00:00:00.000Z'::timestamptz,
       '2026-06-17T00:00:00.000Z'::timestamptz,
       NULL
     FROM generate_series(0, $3::integer - 1) AS series(n)
     ON CONFLICT (id) DO NOTHING`,
    [appId, DEFAULT_AGENT_ID, 300, BENCHMARK_RUN_ID],
  );

  await runtime.service.pool.query(
    `INSERT INTO provider_sessions (
       id, app_id, agent_session_id, provider, external_session_id,
       provider_ref_json, metadata_json, status, created_at, updated_at
     )
     SELECT
       $5 || ':provider-read-session:' || n || ':current',
       $1,
       $5 || ':provider-read-agent-session:' || n,
       $2,
       $5 || ':provider-read-external:' || n || ':current',
       jsonb_build_object(
         'kind', 'provider_session',
         'value', $2 || ':' || $5 || ':provider-read-external:' || n || ':current',
         'provider', $2,
         'externalSessionId', $5 || ':provider-read-external:' || n || ':current'
       ),
       jsonb_build_object('seed', 'benchmark-provider-session-read-target'),
       'active',
       '2026-06-17T00:00:00.000Z'::timestamptz,
       '2026-06-17T00:00:01.000Z'::timestamptz + (n || ' milliseconds')::interval
     FROM generate_series(0, $4::integer - 1) AS series(n)
     UNION ALL
     SELECT
       $5 || ':provider-read-session:' || n || ':older',
       $1,
       $5 || ':provider-read-agent-session:' || n,
       CASE WHEN n % 2 = 0 THEN $2 ELSE $3 END,
       $5 || ':provider-read-external:' || n || ':older',
       jsonb_build_object(
         'kind', 'provider_session',
         'value', (CASE WHEN n % 2 = 0 THEN $2 ELSE $3 END) || ':' || $5 || ':provider-read-external:' || n || ':older',
         'provider', CASE WHEN n % 2 = 0 THEN $2 ELSE $3 END,
         'externalSessionId', $5 || ':provider-read-external:' || n || ':older'
       ),
       jsonb_build_object('seed', 'benchmark-provider-session-read-target'),
       'active',
       '2026-06-17T00:00:00.000Z'::timestamptz,
       '2026-06-17T00:00:00.000Z'::timestamptz + (n || ' milliseconds')::interval
     FROM generate_series(0, $4::integer - 1) AS series(n)
     ON CONFLICT (id) DO NOTHING`,
    [
      appId,
      BENCHMARK_EXECUTION_PROVIDER_ID,
      'deepagents:langchain',
      300,
      BENCHMARK_RUN_ID,
    ],
  );

  await runtime.service.pool.query(
    `INSERT INTO provider_sessions (
       id, app_id, agent_session_id, provider, external_session_id,
       provider_ref_json, metadata_json, status, created_at, updated_at
     )
     SELECT
       $4 || ':provider-read-session:0:distractor:' || n,
       $1,
       $4 || ':provider-read-agent-session:0',
       $2,
       $4 || ':provider-read-external:0:distractor:' || n,
       jsonb_build_object(
         'kind', 'provider_session',
         'value', $2 || ':' || $4 || ':provider-read-external:0:distractor:' || n,
         'provider', $2,
         'externalSessionId', $4 || ':provider-read-external:0:distractor:' || n
       ),
       jsonb_build_object('seed', 'benchmark-provider-session-index-distractor'),
       'active',
       '2026-06-17T00:00:00.000Z'::timestamptz,
       '2026-06-18T00:00:00.000Z'::timestamptz + (n || ' milliseconds')::interval
     FROM generate_series(1, $3::integer) AS series(n)
     ON CONFLICT (id) DO NOTHING`,
    [appId, 'deepagents:langchain', 200, BENCHMARK_RUN_ID],
  );
}

async function countHistoricalAdmissionsByState(
  runtime: PostgresIntegrationRuntime,
): Promise<Map<string, number>> {
  const result = await runtime.service.pool.query<{
    state: string;
    count: number | string;
  }>(
    `SELECT state, COUNT(*)::int AS count
     FROM live_admission_work_items
     WHERE id LIKE 'historical-admission:%'
     GROUP BY state`,
  );
  return new Map(result.rows.map((row) => [row.state, Number(row.count)]));
}

async function countBenchmarkAdmissionsByState(
  runtime: PostgresIntegrationRuntime,
): Promise<Map<string, number>> {
  const result = await runtime.service.pool.query<{
    state: string;
    count: number | string;
  }>(
    `SELECT state, COUNT(*)::int AS count
     FROM live_admission_work_items
     WHERE id LIKE $1
     GROUP BY state`,
    [`${BENCHMARK_RUN_ID}:admission:%`],
  );
  return new Map(result.rows.map((row) => [row.state, Number(row.count)]));
}

async function providerSessionRowVolumeCounts(
  runtime: PostgresIntegrationRuntime,
): Promise<{
  agentSessionCount: number;
  providerSessionCount: number;
  readTargetCount: number;
}> {
  const result = await runtime.service.pool.query<{
    agent_session_count: number | string;
    provider_session_count: number | string;
    read_target_count: number | string;
  }>(
    `SELECT
       (SELECT COUNT(*)::int
        FROM agent_sessions
        WHERE id LIKE 'historical-provider-agent-session:%'
           OR id LIKE $1)::int AS agent_session_count,
       (SELECT COUNT(*)::int
        FROM provider_sessions
        WHERE id LIKE 'historical-provider-session:%'
           OR id LIKE $2)::int AS provider_session_count,
       (SELECT COUNT(*)::int
        FROM provider_sessions
        WHERE id LIKE $3
          AND status = 'active')::int AS read_target_count`,
    [
      `${BENCHMARK_RUN_ID}:provider-read-agent-session:%`,
      `${BENCHMARK_RUN_ID}:provider-read-session:%`,
      `${BENCHMARK_RUN_ID}:provider-read-session:%:current`,
    ],
  );
  return {
    agentSessionCount: Number(result.rows[0]?.agent_session_count ?? 0),
    providerSessionCount: Number(result.rows[0]?.provider_session_count ?? 0),
    readTargetCount: Number(result.rows[0]?.read_target_count ?? 0),
  };
}

async function seedExplainAdmissionVolume(
  runtime: PostgresIntegrationRuntime,
  appId: AppId,
): Promise<void> {
  await runtime.service.pool.query(
    `INSERT INTO live_admission_work_items (
       id,
       app_id,
       agent_id,
       agent_session_id,
       conversation_id,
       thread_id,
       queue_jid,
       message_id,
       message_cursor,
       sender_user_id,
       sender_display_name,
       idempotency_key,
       state,
       source_kind,
       trigger_decision_json,
       claim_worker_instance_id,
       claim_token,
       claim_expires_at,
       fencing_version,
       retry_count,
       defer_until,
       deferred_reason,
       created_at,
       updated_at,
       claimed_at,
       ended_at
     )
     SELECT
       'explain-admission:' || n,
       CASE WHEN n % 11 = 0 THEN 'app:distractor' ELSE $2 END,
       $3,
       'explain-session:' || n,
       'app:live-latency-benchmark:' || (n % 300),
       NULL,
       'app:live-latency-benchmark:' || (n % 300),
       'explain-message:' || n,
       '2026-01-01T00:00:00.000Z::explain::' || n,
       'explain-user:' || n,
       'Explain User',
       'explain-delivery:' || n,
       CASE n % 10
         WHEN 0 THEN 'queued'
         WHEN 1 THEN 'deferred'
         WHEN 2 THEN 'claimed'
         WHEN 3 THEN 'deferred'
         WHEN 4 THEN 'claimed'
         WHEN 5 THEN 'deferred'
         WHEN 6 THEN 'completed'
         WHEN 7 THEN 'failed'
         WHEN 8 THEN 'canceled'
         ELSE 'completed'
       END,
       'message',
       '{}'::jsonb,
       CASE WHEN n % 10 IN (2, 4) THEN 'explain-worker:' || n ELSE NULL END,
       CASE WHEN n % 10 IN (2, 4) THEN 'explain-token:' || n ELSE NULL END,
       CASE
         WHEN n % 10 = 2 THEN '2000-01-01T00:00:00.000Z'::timestamptz
         WHEN n % 10 = 4 THEN '2999-01-01T00:00:00.000Z'::timestamptz
         ELSE NULL
       END,
       CASE WHEN n % 10 IN (2, 4) THEN 1 ELSE 0 END,
       CASE WHEN n % 10 IN (2, 4) THEN 1 ELSE 0 END,
       CASE
         WHEN n % 10 = 1 THEN '2000-01-01T00:00:00.000Z'::timestamptz
         WHEN n % 10 = 3 THEN '2999-01-01T00:00:00.000Z'::timestamptz
         ELSE NULL
       END,
       CASE WHEN n % 10 IN (1, 3, 5) THEN 'retry' ELSE NULL END,
       CASE
         WHEN n % 10 IN (0, 1, 2, 5)
           THEN '2000-01-01T00:00:00.000Z'::timestamptz + (n || ' milliseconds')::interval
         ELSE '2026-01-01T00:00:00.000Z'::timestamptz + (n || ' milliseconds')::interval
       END,
       '2026-01-01T00:00:00.000Z'::timestamptz,
       CASE WHEN n % 10 IN (2, 4) THEN '2026-01-01T00:00:00.000Z'::timestamptz ELSE NULL END,
       CASE WHEN n % 10 IN (6, 7, 8, 9) THEN '2026-01-01T00:00:00.000Z'::timestamptz ELSE NULL END
     FROM generate_series(1, $1::integer) AS series(n)`,
    [HISTORICAL_ADMISSION_COUNT, appId, DEFAULT_AGENT_ID],
  );
}

function liveAdmissionClaimPredicateSql(
  nowPlaceholder: string,
  appIdPlaceholder: string,
): string {
  return `(app_id = ${appIdPlaceholder}
       AND state IN ('queued', 'deferred', 'claimed')
       AND (
         state = 'queued'
       OR (
         state = 'deferred'
         AND (defer_until IS NULL OR defer_until <= ${nowPlaceholder})
       )
       OR (
         state = 'claimed'
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at <= ${nowPlaceholder}
       )))`;
}

function liveAdmissionClaimExplainSql(tableName: string): string {
  return `WITH queued AS (
  SELECT id, created_at
  FROM ${tableName}
  WHERE app_id = $4
    AND state = 'queued'
  ORDER BY app_id ASC, created_at ASC, id ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED
),
due_deferred AS (
  SELECT id, created_at
  FROM ${tableName}
  WHERE app_id = $4
    AND state = 'deferred'
    AND defer_until <= $1
  ORDER BY app_id ASC, defer_until ASC, created_at ASC, id ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED
),
null_deferred AS (
  SELECT id, created_at
  FROM ${tableName}
  WHERE app_id = $4
    AND state = 'deferred'
    AND defer_until IS NULL
  ORDER BY app_id ASC, created_at ASC, id ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED
),
expired_claimed AS (
  SELECT id, created_at
  FROM ${tableName}
  WHERE app_id = $4
    AND state = 'claimed'
    AND claim_expires_at IS NOT NULL
    AND claim_expires_at <= $1
  ORDER BY app_id ASC, claim_expires_at ASC, created_at ASC, id ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED
),
candidates AS (
  SELECT id, created_at FROM queued
  UNION ALL
  SELECT id, created_at FROM due_deferred
  UNION ALL
  SELECT id, created_at FROM null_deferred
  UNION ALL
  SELECT id, created_at FROM expired_claimed
)
SELECT id
FROM candidates
ORDER BY created_at ASC, id ASC
LIMIT $2
`;
}

function planNumber(
  node: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = node[field];
  return typeof value === 'number' ? value : undefined;
}

function collectBufferFields(
  node: Record<string, unknown>,
): Record<string, number> {
  const buffers: Record<string, number> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.endsWith(' Blocks') && typeof value === 'number') {
      buffers[key] = value;
    }
  }
  return buffers;
}

function walkPlanNodes(
  node: ExplainPlanNode,
  visit: (node: ExplainPlanNode) => void,
): void {
  visit(node);
  for (const child of node.Plans ?? []) {
    walkPlanNodes(child, visit);
  }
}

function collectScanNodes(plan: ExplainPlanNode): ScanNodeEvidence[] {
  const scanNodes: ScanNodeEvidence[] = [];
  walkPlanNodes(plan, (node) => {
    const nodeType = String(node['Node Type'] ?? '');
    if (!nodeType.includes('Scan')) return;
    scanNodes.push({
      nodeType,
      relationName:
        typeof node['Relation Name'] === 'string'
          ? node['Relation Name']
          : undefined,
      indexName:
        typeof node['Index Name'] === 'string' ? node['Index Name'] : undefined,
      actualRows: planNumber(node, 'Actual Rows'),
      actualLoops: planNumber(node, 'Actual Loops'),
      rowsRemovedByFilter: planNumber(node, 'Rows Removed by Filter'),
      buffers: collectBufferFields(node),
    });
  });
  return scanNodes;
}

function collectPlanNodes(plan: ExplainPlanNode): PlanNodeEvidence[] {
  const nodes: PlanNodeEvidence[] = [];
  walkPlanNodes(plan, (node) => {
    nodes.push({
      nodeType: String(node['Node Type'] ?? ''),
      actualRows: planNumber(node, 'Actual Rows'),
      actualLoops: planNumber(node, 'Actual Loops'),
    });
  });
  return nodes;
}

function collectObservedIndexes(plan: ExplainPlanNode): string[] {
  const indexes = new Set<string>();
  walkPlanNodes(plan, (node) => {
    if (typeof node['Index Name'] === 'string') {
      indexes.add(node['Index Name']);
    }
  });
  return [...indexes].sort();
}

function sumScanRowsRemoved(scanNodes: ScanNodeEvidence[]): number {
  return scanNodes.reduce(
    (total, node) => total + (node.rowsRemovedByFilter ?? 0),
    0,
  );
}

function sumBuffers(scanNodes: ScanNodeEvidence[]): Record<string, number> {
  const buffers: Record<string, number> = {};
  for (const node of scanNodes) {
    for (const [key, value] of Object.entries(node.buffers)) {
      buffers[key] = (buffers[key] ?? 0) + value;
    }
  }
  return buffers;
}

function normalizeExplainPayload(payload: unknown): {
  Plan: ExplainPlanNode;
  'Planning Time'?: number;
  'Execution Time'?: number;
} {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'object') {
    throw new Error('Unexpected EXPLAIN JSON payload');
  }
  return parsed[0] as {
    Plan: ExplainPlanNode;
    'Planning Time'?: number;
    'Execution Time'?: number;
  };
}

async function publishStartupDiagnostics(input: {
  runtime: PostgresIntegrationRuntime;
  appId: AppId;
  runId: string;
}): Promise<void> {
  const publishRuntimeEvent = (event: RuntimeEventPublishInput) =>
    input.runtime.storageRuntime.runtimeEvents.publish(event);
  await publishRuntimeEvent(
    buildRunnerHostStartupDiagnosticEvent({
      appId: input.appId,
      agentId: DEFAULT_AGENT_ID,
      runId: input.runId,
      conversationId: BENCHMARK_CONVERSATION_ID,
      agentEngine: DEEPAGENTS_ENGINE,
      executionProviderId: 'deepagents:langchain',
      hostPhases: {
        mcpProjectionMs: 12,
        sandboxSpecMs: 4,
      },
      toolPolicyRuleCount: 0,
      gantryMcpToolCount: 0,
      attachedMcpSourceCount: 0,
      projectedMcpSourceCount: 0,
      selectedMcpServerCount: 0,
      materializedMcpServerCount: 0,
      runnerVisibleMcpServerCount: 0,
      reviewedMcpToolCount: 0,
      mcpConfigProjected: false,
      mcpTransportCounts: { stdio: 0, http: 0, sse: 0 },
      selectedSkillSourceCount: 0,
      selectedSkillDisplayCount: 0,
      selectedSkillSecretEnvCount: 0,
      semanticCapabilityCount: 0,
      runtimeAccessCount: 0,
      browserIpcEnabled: false,
      memoryIpcActionCount: 0,
      deepAgentCheckpointerConfigured: true,
      sandbox: {
        provider: 'direct',
        enforcing: false,
        allowedNetworkHostCount: 0,
        protectedReadPathCount: 0,
        protectedWritePathCount: 0,
        localCliCredentialPathCount: 0,
        warmTemplateAvailable: false,
        warmTemplateCacheHit: false,
      },
      egress: {
        proxyConfigured: false,
        upstreamProxyConfigured: false,
      },
      credentials: {
        brokerApplied: true,
        credentialProviderCount: 1,
        modelCredentialEnvKeyCount: 1,
      },
      prompt: {
        compiledSystemPromptChars: 0,
      },
    }),
  );
  await publishRuntimeEvent(
    buildDeepAgentStartupDiagnosticEvent({
      agentInput: {
        appId: input.appId,
        agentId: DEFAULT_AGENT_ID,
        runId: input.runId,
        prompt: 'benchmark',
        workspaceFolder: '/tmp/gantry-live-latency-benchmark',
        chatJid: BENCHMARK_CONVERSATION_ID,
      },
      modelProvider: 'openai',
      modelId: 'benchmark-model',
      endpointFamily: 'openai',
      timing: {
        totalMs: 40,
        firstVisibleOutputMs: 21,
        toolStartCount: 0,
        phases: {
          modelBuildMs: 3,
          mcpConnectMs: 5,
          permissionEnvMs: 1,
        },
      },
      selectedAllowedToolCount: 0,
      connectedToolCount: 0,
      systemPromptChars: 0,
      memoryContextChars: 0,
      turnMessageCount: 1,
      cacheMode: 'none',
      checkpointerConfigured: true,
      checkpointTiming: {
        loadCount: 1,
        loadMs: 9,
        writeCount: 1,
        writeMs: 18,
      },
      scheduledJob: false,
    }) as RuntimeEventPublishInput,
  );
  const runnerProcessEvents: Promise<unknown>[] = [];
  publishRunnerProcessStartupDiagnostic({
    spec: {
      input: {
        appId: input.appId,
        agentId: DEFAULT_AGENT_ID,
        runId: input.runId,
        prompt: 'benchmark',
        workspaceFolder: '/tmp/gantry-live-latency-benchmark',
        chatJid: BENCHMARK_CONVERSATION_ID,
      },
      options: {
        publishRuntimeEvent: (event) => {
          const published = publishRuntimeEvent(event);
          runnerProcessEvents.push(published);
          return published;
        },
        runnerSandboxProvider: {
          id: 'direct',
          enforcing: false,
        },
      },
    } as RunnerProcessSpec,
    code: 0,
    signal: null,
    hadStreamingOutput: true,
    timedOut: false,
    timeoutReason: 'timeout',
    startupTiming: {
      hostPreSpawnMs: 1,
      sandboxStartCallMs: 6,
      firstVisibleOutputMs: 31,
      hostPhases: {
        mcpProjectionMs: 12,
        sandboxSpecMs: 4,
      },
    },
  });
  await Promise.all(runnerProcessEvents);
  await publishRuntimeEvent(
    runnerStartupTimingRuntimeEvent({
      agentInput: {
        appId: input.appId,
        agentId: DEFAULT_AGENT_ID,
        runId: input.runId,
        prompt: 'benchmark',
        workspaceFolder: '/tmp/gantry-live-latency-benchmark',
        chatJid: BENCHMARK_CONVERSATION_ID,
      },
      persistSdkSession: true,
      resumedSession: false,
      sdkQueryPreparedMs: 2,
      sdkQueryIteratorMs: 3,
      firstSdkEventMs: 4,
      providerSessionMs: 5,
      firstVisibleOutputMs: 17,
      firstResultMs: 23,
      messageCount: 4,
      resultCount: 1,
      availableToolCount: 14,
      allowedToolCount: 3,
      disallowedToolCount: 1,
      mcpServerCount: 1,
    }) as RuntimeEventPublishInput,
  );
}

maybeDescribe('live latency benchmark (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'live_latency_benchmark',
    });
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('rolls up 300 durable live admissions with required startup and UX fields', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    await runtime.repositories.providerConnections.saveProviderConnection({
      id: BENCHMARK_PROVIDER_CONNECTION_ID as never,
      appId,
      providerId: 'telegram' as never,
      externalInstallationRef: {
        kind: 'provider_connection',
        value: BENCHMARK_PROVIDER_CONNECTION_ID,
      },
      label: 'Live Latency Benchmark',
      status: 'active',
      config: {},
      runtimeSecretRefs: [],
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
    });
    await runtime.repositories.conversations.saveConversation({
      id: BENCHMARK_CONVERSATION_ID as never,
      appId,
      providerConnectionId: BENCHMARK_PROVIDER_CONNECTION_ID as never,
      externalRef: { kind: 'conversation', value: BENCHMARK_CONVERSATION_ID },
      kind: 'group',
      title: 'Live Latency Benchmark',
      status: 'active',
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
    });
    const runIdsByItemId = itemRunIdsByItemId(BENCHMARK_RUN_ID, 300);
    const now = new Date().toISOString();
    await seedHistoricalNonBlockingLiveAdmissionVolume(runtime, appId);
    await seedHistoricalTerminalLiveTurns(runtime, appId);
    await seedProviderSessionRowVolume(runtime, appId);

    const historicalAdmissionCounts =
      await countHistoricalAdmissionsByState(runtime);
    expect(
      [...historicalAdmissionCounts.values()].reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBe(HISTORICAL_ADMISSION_COUNT);
    for (const state of [
      'deferred',
      'claimed',
      'completed',
      'failed',
      'canceled',
    ]) {
      expect(historicalAdmissionCounts.get(state)).toBeGreaterThan(0);
    }
    const terminalTurnCount = await runtime.service.pool.query<{
      count: number | string;
    }>(
      `SELECT COUNT(*)::int AS count
       FROM live_turns
       WHERE id LIKE 'historical-live-turn:%'
         AND state IN ('completed', 'failed', 'timed_out')`,
    );
    expect(Number(terminalTurnCount.rows[0]?.count ?? 0)).toBe(
      HISTORICAL_TERMINAL_TURN_COUNT,
    );
    const providerSessionCounts = await providerSessionRowVolumeCounts(runtime);
    expect(providerSessionCounts.agentSessionCount).toBeGreaterThanOrEqual(
      HISTORICAL_AGENT_SESSION_COUNT + 300,
    );
    expect(providerSessionCounts.providerSessionCount).toBeGreaterThanOrEqual(
      HISTORICAL_PROVIDER_SESSION_COUNT + 600,
    );
    expect(providerSessionCounts.readTargetCount).toBe(300);

    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        runtime.canonicalSessionRepository.setProviderSession({
          appId,
          workspaceFolder: `live_latency_benchmark_agent_${index}`,
          executionProviderId: BENCHMARK_EXECUTION_PROVIDER_ID,
          scopeKey: `provider-write-scope:${index}`,
          sessionId: providerWriteSessionId(index, 'old'),
        }),
      ),
    );

    for (const runId of runIdsByItemId.values()) {
      await runtime.repositories.agentRuns.saveAgentRun({
        id: runId as AgentRunId,
        appId,
        agentId: DEFAULT_AGENT_ID as never,
        configVersionId: `config:${DEFAULT_AGENT_ID}:1` as never,
        llmProfileId: DEFAULT_LLM_PROFILE_ID as never,
        executionProviderId: 'deepagents:langchain' as never,
        permissionDecisionIds: [],
        cause: 'message',
        status: 'running',
        createdAt: now,
        startedAt: now,
      });
      await publishStartupDiagnostics({ runtime, appId, runId });
    }
    const startupDiagnosticsByItemId =
      await loadLiveLatencyStartupDiagnosticsFromRuntimeEvents({
        runtimeEvents: runtime.repositories.runtimeEvents,
        appId,
        itemRunIdsByItemId: runIdsByItemId,
      });
    const reportArtifactPath = path.join(
      runtime.artifactRoot,
      'reports',
      `${BENCHMARK_RUN_ID}.json`,
    );

    const report = await runSyntheticLiveLatencyBenchmark({
      liveAdmissions: runtime.repositories.liveTurns,
      postgresHotPathObserver: createPostgresLiveLatencyHotPathObserver(
        runtime.service.pool,
      ),
      concurrency: 300,
      workerCount: 12,
      claimBatchSize: 25,
      firstVisibleSloMs: 5_000,
      benchmarkRunId: BENCHMARK_RUN_ID,
      startupDiagnosticsByItemId,
      reportArtifactPath,
      providerSessionOperations: {
        read: async ({ sampleId }) => {
          const index = benchmarkSampleIndex(sampleId);
          const providerSession =
            await runtime.repositories.providerSessions.getLatestProviderSession(
              {
                agentSessionId: providerReadAgentSessionId(index),
                provider: BENCHMARK_EXECUTION_PROVIDER_ID,
              },
            );
          expect(providerSession).toMatchObject({
            id: providerReadSessionId(index),
            provider: BENCHMARK_EXECUTION_PROVIDER_ID,
            status: 'active',
          });
        },
        write: async ({ sampleId }) => {
          const index = benchmarkSampleIndex(sampleId);
          await expect(
            runtime.canonicalSessionRepository.setProviderSession({
              appId,
              workspaceFolder: `live_latency_benchmark_agent_${index}`,
              executionProviderId: BENCHMARK_EXECUTION_PROVIDER_ID,
              scopeKey: `provider-write-scope:${index}`,
              sessionId: providerWriteSessionId(index, 'current'),
            }),
          ).resolves.toBe(true);
        },
      },
      syntheticLatenciesMs: {
        hydrationLagMs: 1,
        bridgeLagMs: 1,
        checkpointLoadMs: 2,
        checkpointWriteMs: 3,
        asyncDelegationLaunchAckMs: 1,
        delegationProgressEventMs: 1,
        streamRejoinMs: 1,
        queuedInputWakeMs: 1,
        mcpClientStartupMs: 2,
        toolListingFilteringMs: 2,
        toolSchemaSerializationMs: 2,
        permissionHitlSetupMs: 1,
        sandboxReadinessMs: 1,
        sandboxTemplateMs: 1,
        sandboxSpecMs: 1,
        sandboxStartMs: 1,
        sandboxFirstToolReadyMs: 1,
        modelConstructionMs: 2,
        notifyLagMs: 0,
      },
      sleepMs: async () => undefined,
    });

    expect(report.sampleCount).toBe(300);
    expect(report.concurrency).toBe(300);
    expect(
      (await countBenchmarkAdmissionsByState(runtime)).get('completed'),
    ).toBe(300);
    expect(Object.keys(report.metrics).sort()).toEqual(
      [...LIVE_LATENCY_BENCHMARK_METRIC_NAMES].sort(),
    );
    for (const metricName of LIVE_LATENCY_BENCHMARK_METRIC_NAMES) {
      expect(report.metrics[metricName].count).toBe(300);
      expect(report.metrics[metricName].p50).not.toBeNull();
      expect(report.metrics[metricName].p95).not.toBeNull();
      expect(report.metrics[metricName].p99).not.toBeNull();
    }

    expect(report.metrics.acceptedToFirstVisibleMs.p95).toBeGreaterThanOrEqual(
      17,
    );
    expect(report.metrics.acceptedToFirstVisibleMs.source).toBe('measured');
    expect(report.metrics.checkpointLoadMs).toMatchObject({
      p95: 9,
      source: 'measured',
    });
    expect(report.metrics.checkpointWriteMs).toMatchObject({
      p95: 18,
      source: 'measured',
    });
    expect(report.metrics.providerSessionReadMs).toMatchObject({
      count: 300,
      source: 'measured',
    });
    expect(report.metrics.providerSessionWriteMs).toMatchObject({
      count: 300,
      source: 'measured',
    });
    expect(report.metrics.mcpClientStartupMs).toMatchObject({
      p95: 5,
      source: 'measured',
    });
    expect(report.metrics.toolListingFilteringMs).toMatchObject({
      p95: 12,
      source: 'measured',
    });
    expect(report.metrics.sandboxSpecMs).toMatchObject({
      p95: 4,
      source: 'measured',
    });
    expect(report.metrics.sandboxStartMs).toMatchObject({
      p95: 6,
      source: 'measured',
    });
    expect(report.syntheticMetricNames).not.toContain('checkpointLoadMs');
    expect(report.syntheticMetricNames).not.toContain('providerSessionReadMs');
    expect(report.syntheticMetricNames).not.toContain('providerSessionWriteMs');
    expect(report.syntheticMetricNames).not.toContain('sandboxStartMs');
    expect(report.syntheticMetricNames).not.toContain('poolCheckoutWaitMs');
    expect(report.syntheticMetricNames).not.toContain('pgLockWaitMs');
    expect(report.measuredMetricNames).toContain('acceptedToFirstVisibleMs');
    expect(report.measuredMetricNames).toContain('admissionLagMs');
    expect(report.measuredMetricNames).toContain('poolCheckoutWaitMs');
    expect(report.measuredMetricNames).toContain('queryElapsedMs');
    expect(report.measuredMetricNames).toContain('transactionElapsedMs');
    expect(report.measuredMetricNames).toContain('pgLockWaitMs');
    expect(report.measuredMetricNames).toContain('liveAdmissionClaimMs');
    expect(report.measuredMetricNames).toContain('checkpointLoadMs');
    expect(report.measuredMetricNames).toContain('providerSessionReadMs');
    expect(report.measuredMetricNames).toContain('providerSessionWriteMs');
    expect(report.measuredMetricNames).toContain('mcpClientStartupMs');
    expect(report.measuredMetricNames).toContain('toolListingFilteringMs');
    expect(report.measuredMetricNames).toContain('permissionHitlSetupMs');
    expect(report.measuredMetricNames).toContain('sandboxSpecMs');
    expect(report.measuredMetricNames).toContain('sandboxStartMs');
    expect(report.measuredMetricNames).toContain('modelConstructionMs');
    expect(
      (report.metrics as Record<string, unknown>).dbPoolWaitMs,
    ).toBeUndefined();
    expect(
      (report.metrics as Record<string, unknown>).lockWaitMs,
    ).toBeUndefined();
    expect(report.readiness.passed).toBe(false);
    expect(report.readiness.failedMetricNames).toEqual([]);
    expect(report.readiness.failedMetricNames).not.toContain(
      'poolCheckoutWaitMs',
    );
    expect(report.readiness.failedMetricNames).not.toContain('pgLockWaitMs');
    expect(report.readiness.failureReasons).toEqual(['synthetic_benchmark']);
    expect(
      report.readiness.metrics.acceptedToFirstVisibleMs.evidenceSourceCounts
        .runner_origin,
    ).toBe(300);
    expect(
      report.readiness.metrics.toolListingFilteringMs.evidenceSourceCounts
        .runtime_origin,
    ).toBe(300);
    expect(
      report.readiness.metrics.sandboxSpecMs.evidenceSourceCounts
        .runtime_origin,
    ).toBe(300);
    expect(report.deferredCount).toBe(0);
    expect(report.degradedCount).toBe(0);
    expect(report.failureCount).toBe(0);
    expect(report.backgroundClaimCount).toBe(0);
    expect(report.missingMetricNames).toEqual([]);

    const providerSessionMetricsArtifactPath = path.join(
      process.cwd(),
      '.factory',
      'benchmarks',
      'postgres-hot-paths',
      PROVIDER_SESSION_EXPLAIN_RUN_ID,
      PROVIDER_SESSION_METRICS_ARTIFACT_NAME,
    );
    const providerSessionMetricsArtifact = {
      schemaVersion: 1,
      benchmarkRunId: PROVIDER_SESSION_EXPLAIN_RUN_ID,
      generatedAt: new Date().toISOString(),
      benchmarkEvidenceSource: report.benchmarkEvidenceSource,
      sampleCount: report.sampleCount,
      concurrency: report.concurrency,
      providerSessionRowVolume: providerSessionCounts,
      metrics: {
        providerSessionReadMs: report.metrics.providerSessionReadMs,
        providerSessionWriteMs: report.metrics.providerSessionWriteMs,
      },
      measuredMetricNames: report.measuredMetricNames.filter(
        (metricName) =>
          metricName === 'providerSessionReadMs' ||
          metricName === 'providerSessionWriteMs',
      ),
      readiness: report.readiness,
    };
    fs.mkdirSync(path.dirname(providerSessionMetricsArtifactPath), {
      recursive: true,
    });
    fs.writeFileSync(
      providerSessionMetricsArtifactPath,
      `${JSON.stringify(providerSessionMetricsArtifact, null, 2)}\n`,
    );

    const artifact = JSON.parse(fs.readFileSync(reportArtifactPath, 'utf8'));
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      benchmarkRunId: BENCHMARK_RUN_ID,
      report: {
        sampleCount: 300,
        backgroundClaimCount: 0,
        measuredMetricNames: expect.arrayContaining([
          'checkpointLoadMs',
          'providerSessionReadMs',
          'providerSessionWriteMs',
          'poolCheckoutWaitMs',
          'pgLockWaitMs',
        ]),
        readiness: {
          passed: false,
          failedMetricNames: [],
          failureReasons: ['synthetic_benchmark'],
        },
      },
    });
    expect(artifact.generatedAt).toEqual(expect.any(String));
    expect(artifact.report.metrics.sandboxStartMs).toMatchObject({
      p95: 6,
      source: 'measured',
    });
    const providerArtifact = JSON.parse(
      fs.readFileSync(providerSessionMetricsArtifactPath, 'utf8'),
    );
    expect(providerArtifact).toMatchObject({
      schemaVersion: 1,
      benchmarkRunId: PROVIDER_SESSION_EXPLAIN_RUN_ID,
      sampleCount: 300,
      concurrency: 300,
      metrics: {
        providerSessionReadMs: { count: 300, source: 'measured' },
        providerSessionWriteMs: { count: 300, source: 'measured' },
      },
      measuredMetricNames: ['providerSessionReadMs', 'providerSessionWriteMs'],
    });
  }, 180_000);

  it('writes a rollback-only live admission claim EXPLAIN plan artifact', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    const now = new Date().toISOString();
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    const candidateSql = liveAdmissionClaimExplainSql(tableName);
    const artifactPath = path.join(
      process.cwd(),
      '.factory',
      'benchmarks',
      'postgres-hot-paths',
      LIVE_ADMISSION_EXPLAIN_RUN_ID,
      LIVE_ADMISSION_EXPLAIN_ARTIFACT_NAME,
    );

    await seedExplainAdmissionVolume(runtime, appId);
    await runtime.service.pool.query(`ANALYZE ${tableName}`);

    const counts = await runtime.service.pool.query<{
      table_cardinality: number | string;
      candidate_count: number | string;
      queued_candidate_count: number | string;
      due_deferred_candidate_count: number | string;
      null_deferred_candidate_count: number | string;
      expired_claimed_candidate_count: number | string;
      future_deferred_count: number | string;
      live_claimed_count: number | string;
      terminal_count: number | string;
    }>(
      `SELECT
         COUNT(*)::int AS table_cardinality,
         (COUNT(*) FILTER (WHERE ${liveAdmissionClaimPredicateSql('$1', '$2')}))::int
           AS candidate_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'explain-admission:%'
             AND app_id = $2
             AND state = 'queued'
         ))::int AS queued_candidate_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'explain-admission:%'
             AND app_id = $2
             AND state = 'deferred'
             AND defer_until <= $1
         ))::int AS due_deferred_candidate_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'explain-admission:%'
             AND app_id = $2
             AND state = 'deferred'
             AND defer_until IS NULL
         ))::int AS null_deferred_candidate_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'explain-admission:%'
             AND app_id = $2
             AND state = 'claimed'
             AND claim_expires_at IS NOT NULL
             AND claim_expires_at <= $1
         ))::int AS expired_claimed_candidate_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'explain-admission:%'
             AND app_id = $2
             AND state = 'deferred'
             AND defer_until > $1
         ))::int AS future_deferred_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'explain-admission:%'
             AND app_id = $2
             AND state = 'claimed'
             AND claim_expires_at > $1
         ))::int AS live_claimed_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'explain-admission:%'
             AND app_id = $2
             AND state IN ('completed', 'failed', 'canceled')
         ))::int AS terminal_count
       FROM ${tableName}`,
      [now, appId],
    );
    const tableCardinality = Number(counts.rows[0]?.table_cardinality ?? 0);
    const candidateCount = Number(counts.rows[0]?.candidate_count ?? 0);
    expect(tableCardinality).toBeGreaterThanOrEqual(HISTORICAL_ADMISSION_COUNT);
    expect(candidateCount).toBeGreaterThan(LIVE_ADMISSION_EXPLAIN_LIMIT);
    expect(Number(counts.rows[0]?.queued_candidate_count ?? 0)).toBeGreaterThan(
      0,
    );
    expect(
      Number(counts.rows[0]?.due_deferred_candidate_count ?? 0),
    ).toBeGreaterThan(0);
    expect(
      Number(counts.rows[0]?.null_deferred_candidate_count ?? 0),
    ).toBeGreaterThan(0);
    expect(
      Number(counts.rows[0]?.expired_claimed_candidate_count ?? 0),
    ).toBeGreaterThan(0);
    expect(Number(counts.rows[0]?.future_deferred_count ?? 0)).toBeGreaterThan(
      0,
    );
    expect(Number(counts.rows[0]?.live_claimed_count ?? 0)).toBeGreaterThan(0);
    expect(Number(counts.rows[0]?.terminal_count ?? 0)).toBeGreaterThan(0);

    const client = await runtime.service.pool.connect();
    let explainPayload: unknown;
    try {
      await client.query('BEGIN');
      const explain = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
${candidateSql}`,
        [
          now,
          LIVE_ADMISSION_EXPLAIN_LIMIT,
          LIVE_ADMISSION_EXPLAIN_CANDIDATE_LIMIT,
          appId,
        ],
      );
      explainPayload = explain.rows[0]?.['QUERY PLAN'];
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const afterExplain = await runtime.service.pool.query<{
      candidate_count: number | string;
    }>(
      `SELECT (COUNT(*) FILTER (
         WHERE ${liveAdmissionClaimPredicateSql('$1', '$2')}
       ))::int AS candidate_count
       FROM ${tableName}`,
      [now, appId],
    );
    expect(Number(afterExplain.rows[0]?.candidate_count ?? 0)).toBe(
      candidateCount,
    );

    const lockProbe = await runtime.service.pool.connect();
    try {
      await lockProbe.query('BEGIN');
      const lockResult = await lockProbe.query(
        candidateSql.replaceAll('FOR UPDATE SKIP LOCKED', 'FOR UPDATE NOWAIT'),
        [now, 1, 4, appId],
      );
      expect(lockResult.rowCount).toBe(1);
    } finally {
      await lockProbe.query('ROLLBACK').catch(() => undefined);
      lockProbe.release();
    }

    const explainRoot = normalizeExplainPayload(explainPayload);
    expect(explainRoot.Plan).toBeDefined();
    const scanNodes = collectScanNodes(explainRoot.Plan);
    const planNodes = collectPlanNodes(explainRoot.Plan);
    const observedIndexes = collectObservedIndexes(explainRoot.Plan);
    const actualRows = planNumber(explainRoot.Plan, 'Actual Rows') ?? 0;
    const scannedRows = scanNodes
      .filter((node) => node.nodeType !== 'CTE Scan')
      .reduce(
        (total, node) =>
          total + (node.actualRows ?? 0) * (node.actualLoops ?? 1),
        0,
      );
    const rowsScannedToReturnedRatio =
      actualRows > 0 ? scannedRows / actualRows : null;
    const usedBroadTableScan = scanNodes.some((node) => {
      if (node.relationName !== 'live_admission_work_items') return false;
      if (node.nodeType === 'Seq Scan') return true;
      if (node.nodeType !== 'Bitmap Heap Scan') return false;
      return (
        (node.actualRows ?? 0) * (node.actualLoops ?? 1) >
        LIVE_ADMISSION_EXPLAIN_LIMIT * ROWS_SCANNED_TO_RETURNED_RATIO_GATE
      );
    });
    const usedBranchIndexes = LIVE_ADMISSION_EXPECTED_BRANCH_INDEXES.every(
      (indexName) => observedIndexes.includes(indexName),
    );
    const unboundedSort = planNodes.some(
      (node) =>
        node.nodeType === 'Sort' &&
        (node.actualRows ?? 0) * (node.actualLoops ?? 1) >
          LIVE_ADMISSION_EXPLAIN_LIMIT *
            LIVE_ADMISSION_EXPECTED_BRANCH_INDEXES.length,
    );
    const verdictStatus =
      usedBroadTableScan ||
      !usedBranchIndexes ||
      unboundedSort ||
      (rowsScannedToReturnedRatio !== null &&
        rowsScannedToReturnedRatio > ROWS_SCANNED_TO_RETURNED_RATIO_GATE)
        ? 'follow_up_required'
        : 'acceptable_evidence';
    const artifact = {
      schemaVersion: 1,
      planName: 'live_admission_claim_candidates',
      benchmarkRunId: LIVE_ADMISSION_EXPLAIN_RUN_ID,
      generatedAt: new Date().toISOString(),
      table: {
        schema: runtime.schemaName,
        name: 'live_admission_work_items',
        cardinality: tableCardinality,
      },
      candidateCount,
      limit: LIVE_ADMISSION_EXPLAIN_LIMIT,
      candidateLimit: LIVE_ADMISSION_EXPLAIN_CANDIDATE_LIMIT,
      sql: candidateSql,
      observedIndexes,
      scanNodes,
      planNodes,
      actualRows,
      rowsScannedToReturnedRatio,
      rowsScannedToReturnedRatioGate: ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      rowsRemovedByFilter: sumScanRowsRemoved(scanNodes),
      scanBuffers: sumBuffers(scanNodes),
      buffers: collectBufferFields(explainRoot.Plan),
      planningTimeMs: explainRoot['Planning Time'],
      executionTimeMs: explainRoot['Execution Time'],
      verdict: {
        status: verdictStatus,
        reason:
          verdictStatus === 'follow_up_required'
            ? 'Current plan did not satisfy the post-remediation index and scanned-to-returned row gates for the claim candidate scan.'
            : 'Current plan produced branch-index-backed evidence for the claim candidate scan.',
        followUp:
          verdictStatus === 'follow_up_required'
            ? 'LOCAL-41 live admission split-query or branch-specific index follow-up'
            : null,
      },
      plan: explainRoot,
    };

    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

    const writtenArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    expect(writtenArtifact).toMatchObject({
      schemaVersion: 1,
      planName: 'live_admission_claim_candidates',
      benchmarkRunId: LIVE_ADMISSION_EXPLAIN_RUN_ID,
      table: {
        name: 'live_admission_work_items',
        cardinality: tableCardinality,
      },
      candidateCount,
      limit: LIVE_ADMISSION_EXPLAIN_LIMIT,
      candidateLimit: LIVE_ADMISSION_EXPLAIN_CANDIDATE_LIMIT,
    });
    expect(writtenArtifact.sql).toContain("state = 'queued'");
    expect(writtenArtifact.sql).toContain("state = 'deferred'");
    expect(writtenArtifact.sql).toContain("state = 'claimed'");
    expect(writtenArtifact.sql).toContain('app_id = $4');
    expect(writtenArtifact.sql).toContain('UNION ALL');
    expect(writtenArtifact.sql).toContain(
      'ORDER BY app_id ASC, created_at ASC, id ASC',
    );
    expect(writtenArtifact.sql).toContain('LIMIT $2');
    expect(writtenArtifact.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(writtenArtifact.observedIndexes).toEqual(expect.any(Array));
    for (const indexName of LIVE_ADMISSION_EXPECTED_BRANCH_INDEXES) {
      expect(writtenArtifact.observedIndexes).toContain(indexName);
    }
    expect(writtenArtifact.scanNodes.length).toBeGreaterThan(0);
    expect(writtenArtifact.scanNodes[0]).toMatchObject({
      nodeType: expect.any(String),
    });
    expect(writtenArtifact.rowsScannedToReturnedRatio).toEqual(
      expect.any(Number),
    );
    expect(writtenArtifact.rowsScannedToReturnedRatio).toBeLessThanOrEqual(
      writtenArtifact.rowsScannedToReturnedRatioGate,
    );
    expect(
      writtenArtifact.planNodes.some(
        (node: {
          nodeType?: string;
          actualRows?: number;
          actualLoops?: number;
        }) =>
          node.nodeType === 'Sort' &&
          (node.actualRows ?? 0) * (node.actualLoops ?? 1) >
            writtenArtifact.limit *
              LIVE_ADMISSION_EXPECTED_BRANCH_INDEXES.length,
      ),
    ).toBe(false);
    expect(
      writtenArtifact.scanNodes.some(
        (node: {
          nodeType?: string;
          relationName?: string;
          actualRows?: number;
          actualLoops?: number;
        }) => {
          if (node.relationName !== 'live_admission_work_items') return false;
          if (node.nodeType === 'Seq Scan') return true;
          if (node.nodeType !== 'Bitmap Heap Scan') return false;
          return (
            (node.actualRows ?? 0) * (node.actualLoops ?? 1) >
            writtenArtifact.limit *
              writtenArtifact.rowsScannedToReturnedRatioGate
          );
        },
      ),
    ).toBe(false);
    expect(writtenArtifact.verdict.status).toBe('acceptable_evidence');
    expect(typeof writtenArtifact.executionTimeMs).toBe('number');
    expect(Object.keys(writtenArtifact.buffers).length).toBeGreaterThan(0);
  });

  it('writes provider-session resume/write EXPLAIN evidence at row volume', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    const agentTableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('agent_sessions')}`;
    const providerTableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('provider_sessions')}`;
    const artifactPath = path.join(
      process.cwd(),
      '.factory',
      'benchmarks',
      'postgres-hot-paths',
      PROVIDER_SESSION_EXPLAIN_RUN_ID,
      PROVIDER_SESSION_EXPLAIN_ARTIFACT_NAME,
    );

    await seedProviderSessionRowVolume(runtime, appId);
    await runtime.service.pool.query(`ANALYZE ${agentTableName}`);
    await runtime.service.pool.query(`ANALYZE ${providerTableName}`);

    const cardinality = await runtime.service.pool.query<{
      agent_sessions: number | string;
      provider_sessions: number | string;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM ${agentTableName}) AS agent_sessions,
         (SELECT COUNT(*)::int FROM ${providerTableName}) AS provider_sessions`,
    );
    const agentSessionCount = Number(cardinality.rows[0]?.agent_sessions ?? 0);
    const providerSessionCount = Number(
      cardinality.rows[0]?.provider_sessions ?? 0,
    );
    expect(agentSessionCount).toBeGreaterThanOrEqual(
      HISTORICAL_AGENT_SESSION_COUNT + 300,
    );
    expect(providerSessionCount).toBeGreaterThanOrEqual(
      HISTORICAL_PROVIDER_SESSION_COUNT + 600,
    );

    const targetAgentSessionId = providerReadAgentSessionId(0);
    const targetProviderSessionId = providerReadSessionId(0);
    const cases = [
      {
        name: 'agent_owner_lookup',
        expectedIndex: 'idx_agent_sessions_owner',
        sql: `SELECT id FROM ${agentTableName}
              WHERE app_id = $1
                AND agent_id = $2
                AND conversation_id IS NULL
                AND thread_id IS NULL
                AND user_id = $3
                AND job_id IS NULL
              ORDER BY updated_at DESC, id DESC
              LIMIT 1`,
        values: [appId, DEFAULT_AGENT_ID, 'provider-read-user:0'],
      },
      {
        name: 'same_provider_resume_lookup',
        expectedIndex: 'idx_provider_sessions_resume_lookup',
        sql: `SELECT id FROM ${providerTableName}
              WHERE agent_session_id = $1
                AND status = 'active'
                AND provider = $2
              ORDER BY updated_at DESC, created_at DESC, id DESC
              LIMIT 1`,
        values: [targetAgentSessionId, BENCHMARK_EXECUTION_PROVIDER_ID],
      },
      {
        name: 'provider_agnostic_resume_lookup',
        expectedIndex: 'idx_provider_sessions_agent_status_updated',
        sql: `SELECT id FROM ${providerTableName}
              WHERE agent_session_id = $1
                AND status = 'active'
              ORDER BY updated_at DESC, created_at DESC, id DESC
              LIMIT 1`,
        values: [targetAgentSessionId],
      },
      {
        name: 'provider_identity_lock',
        expectedIndex: 'provider_sessions_pkey',
        sql: `SELECT app_id, agent_session_id, provider, external_session_id
              FROM ${providerTableName}
              WHERE id = $1
              FOR UPDATE`,
        values: [targetProviderSessionId],
      },
      {
        name: 'provider_write_cleanup_lookup',
        expectedIndex: 'idx_provider_sessions_agent_provider',
        sql: `SELECT id FROM ${providerTableName}
              WHERE app_id = $1
                AND agent_session_id = $2
                AND provider = $3
                AND id <> $4
              FOR UPDATE`,
        values: [
          appId,
          targetAgentSessionId,
          BENCHMARK_EXECUTION_PROVIDER_ID,
          targetProviderSessionId,
        ],
      },
    ];

    const plans = [];
    const client = await runtime.service.pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of cases) {
        const explain = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.sql}`,
          item.values,
        );
        const root = normalizeExplainPayload(explain.rows[0]?.['QUERY PLAN']);
        const scanNodes = collectScanNodes(root.Plan);
        const planNodes = collectPlanNodes(root.Plan);
        const observedIndexes = collectObservedIndexes(root.Plan);
        const actualRows = planNumber(root.Plan, 'Actual Rows') ?? 0;
        const scannedRows = scanNodes.reduce(
          (total, node) =>
            total +
            ((node.actualRows ?? 0) + (node.rowsRemovedByFilter ?? 0)) *
              (node.actualLoops ?? 1),
          0,
        );
        const rowsScannedToReturnedRatio =
          actualRows > 0 ? scannedRows / actualRows : null;
        const usedSeqScan = scanNodes.some(
          (node) =>
            (node.relationName === 'agent_sessions' ||
              node.relationName === 'provider_sessions') &&
            node.nodeType === 'Seq Scan',
        );
        const verdictStatus =
          usedSeqScan ||
          !observedIndexes.includes(item.expectedIndex) ||
          rowsScannedToReturnedRatio === null ||
          rowsScannedToReturnedRatio > ROWS_SCANNED_TO_RETURNED_RATIO_GATE
            ? 'follow_up_required'
            : 'acceptable_evidence';
        plans.push({
          name: item.name,
          expectedIndex: item.expectedIndex,
          sql: item.sql,
          observedIndexes,
          scanNodes,
          planNodes,
          actualRows,
          rowsScannedToReturnedRatio,
          rowsScannedToReturnedRatioGate: ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
          scanBuffers: sumBuffers(scanNodes),
          buffers: collectBufferFields(root.Plan),
          planningTimeMs: root['Planning Time'],
          executionTimeMs: root['Execution Time'],
          verdict: verdictStatus,
        });
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    const artifact = {
      schemaVersion: 1,
      planName: 'provider_session_resume_write',
      benchmarkRunId: PROVIDER_SESSION_EXPLAIN_RUN_ID,
      generatedAt: new Date().toISOString(),
      tables: {
        agent_sessions: { cardinality: agentSessionCount },
        provider_sessions: { cardinality: providerSessionCount },
      },
      rowsScannedToReturnedRatioGate: ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      cases: plans,
      verdict: {
        status: plans.every((item) => item.verdict === 'acceptable_evidence')
          ? 'acceptable_evidence'
          : 'follow_up_required',
      },
    };

    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

    const writtenArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    expect(writtenArtifact).toMatchObject({
      schemaVersion: 1,
      planName: 'provider_session_resume_write',
      benchmarkRunId: PROVIDER_SESSION_EXPLAIN_RUN_ID,
      verdict: { status: 'acceptable_evidence' },
    });
    expect(writtenArtifact.cases).toHaveLength(cases.length);
    for (const item of writtenArtifact.cases) {
      expect(item.observedIndexes).toContain(item.expectedIndex);
      expect(item.rowsScannedToReturnedRatio).toBeLessThanOrEqual(
        ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      );
      expect(item.verdict).toBe('acceptable_evidence');
    }
  });

  it('samples active Postgres lock waits from pg_locks waitstart', async () => {
    await runtime.service.pool.query(
      'CREATE TABLE IF NOT EXISTS live_latency_lock_probe (id integer PRIMARY KEY, value text NOT NULL)',
    );
    await runtime.service.pool.query(
      `INSERT INTO live_latency_lock_probe (id, value)
       VALUES (1, 'ready')
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
    );

    const holder = await runtime.service.pool.connect();
    const waiter = await runtime.service.pool.connect();
    const observer = createPostgresLiveLatencyHotPathObserver(
      runtime.service.pool,
    );
    let waitingQuery: Promise<unknown> | undefined;

    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT * FROM live_latency_lock_probe WHERE id = 1 FOR UPDATE',
      );
      waitingQuery = waiter.query(
        'SELECT * FROM live_latency_lock_probe WHERE id = 1 FOR UPDATE',
      );

      let observedWaitMs = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        observedWaitMs = await observer.measurePgLockWaitMs();
        if (observedWaitMs > 0) break;
        await sleepMs(20);
      }

      expect(observedWaitMs).toBeGreaterThan(0);
      await holder.query('COMMIT');
      await waitingQuery;
      expect(await observer.measurePgLockWaitMs()).toBe(0);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await waitingQuery?.catch(() => undefined);
      holder.release();
      waiter.release();
    }
  });
});
