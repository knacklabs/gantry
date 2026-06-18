import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import type { AppId } from '@core/domain/app/app.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import {
  collectObservedIndexes,
  collectPlanNodeTypes,
  collectScanNodes,
  normalizeExplainPayload,
  planNumber,
} from '../harness/postgres-explain.js';

const maybeDescribe =
  hasPostgresIntegrationDatabase && process.env.GANTRY_POSTGRES_HOT_PATH === '1'
    ? describe
    : describe.skip;
const RECOVERABLE_SWEEP_RUN_ID = 'live-turn-recoverable-explain-itest';
const LIVE_TURN_SEED_COUNT = 100_000;
const RECOVERABLE_SWEEP_LIMIT = 25;
const RECOVERABLE_SWEEP_CANDIDATE_LIMIT = RECOVERABLE_SWEEP_LIMIT * 4;
const ROWS_SCANNED_TO_RETURNED_RATIO_GATE = 20;

maybeDescribe('Postgres live-turn recoverable sweep plans', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'live_turn_recoverable_explain',
    });
  }, 60_000);

  afterAll(async () => {
    if (!runtime) return;
    await runtime.cleanup();
  });

  it('writes recoverable live-turn sweep EXPLAIN evidence at row volume', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    const configVersionId = `config:${DEFAULT_AGENT_ID}:1`;
    const now = '2026-06-17T01:00:00.000Z';
    const staleBefore = '2026-06-16T12:00:00.000Z';
    const expiredAt = '2026-06-16T00:00:00.000Z';
    const freshAt = '2026-06-17T00:30:00.000Z';
    const futureAt = '2026-06-18T00:00:00.000Z';
    const liveTurnsTable = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_turns')}`;
    const runLeasesTable = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('run_leases')}`;
    const agentRunsTable = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('agent_runs')}`;
    const workerTable = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('worker_instances')}`;
    await runtime.service.pool.query(
      `INSERT INTO ${workerTable} (
         id, boot_nonce, process_role, status, heartbeat_at, last_seen_at, created_at
       )
       VALUES
         ('recoverable-worker-lost', 'nonce-recoverable-worker-lost', 'live-worker', 'healthy', $1, $1, $1),
         ('recoverable-worker-healthy', 'nonce-recoverable-worker-healthy', 'live-worker', 'healthy', $1, $1, $1)
       ON CONFLICT (id) DO NOTHING`,
      [now],
    );
    await runtime.service.pool.query(
      `INSERT INTO ${agentRunsTable} (
         id, app_id, agent_id, config_version_id, llm_profile_id,
         execution_provider_id, permission_decision_ids_json, cause, status,
         created_at, started_at
       )
       SELECT
         'agent-run:recoverable:' || n,
         $2,
         $3,
         $4,
         $5,
         'test:recoverable-live-turns',
         '[]',
         'message',
         'running',
         $6::timestamptz - (n || ' seconds')::interval,
         $6::timestamptz - (n || ' seconds')::interval
       FROM generate_series(1, $1::integer) AS series(n)
       WHERE n % 10 IN (1, 2)`,
      [
        LIVE_TURN_SEED_COUNT,
        appId,
        DEFAULT_AGENT_ID,
        configVersionId,
        DEFAULT_LLM_PROFILE_ID,
        now,
      ],
    );
    await runtime.service.pool.query(
      `INSERT INTO ${runLeasesTable} (
         run_id, worker_instance_id, lease_token, fencing_version, status,
         claimed_at, expires_at, heartbeat_at
       )
       SELECT
         'agent-run:recoverable:' || n,
         CASE WHEN n % 10 = 1 THEN 'recoverable-worker-lost' ELSE 'recoverable-worker-healthy' END,
         'lease:recoverable:' || n,
         1,
         'active',
         $4::timestamptz - (n || ' seconds')::interval,
         CASE WHEN n % 10 = 1 THEN $2::timestamptz ELSE $3::timestamptz END,
         $4::timestamptz - (n || ' seconds')::interval
       FROM generate_series(1, $1::integer) AS series(n)
       WHERE n % 10 IN (1, 2)`,
      [LIVE_TURN_SEED_COUNT, expiredAt, futureAt, now],
    );
    await runtime.service.pool.query(
      `INSERT INTO ${liveTurnsTable} (
         id, scope_key, app_id, agent_session_id, conversation_id, thread_id,
         run_id, state, pending_message_json, stop_alias_jids_json,
         required_continuation_user_id, retry_count, next_command_seq,
         worker_instance_id, lease_token, fencing_version,
         created_at, updated_at, ended_at
       )
       SELECT
         'live-turn:recoverable:' || n,
         'live-recoverable:' || n,
         $2,
         NULL,
         'conversation:recoverable:' || n,
         NULL,
         CASE WHEN n % 10 IN (1, 2) THEN 'agent-run:recoverable:' || n ELSE NULL END,
         CASE n % 10
           WHEN 4 THEN 'completed'
           WHEN 5 THEN 'failed'
           WHEN 6 THEN 'timed_out'
           WHEN 7 THEN 'awaiting_interaction'
           WHEN 8 THEN 'setup_required'
           WHEN 9 THEN 'recovered'
           ELSE 'running'
         END,
         NULL,
         '[]'::jsonb,
         NULL,
         0,
         1,
         CASE
           WHEN n % 10 = 1 THEN 'recoverable-worker-lost'
           WHEN n % 10 = 2 THEN 'recoverable-worker-healthy'
           ELSE NULL
         END,
         CASE WHEN n % 10 IN (1, 2) THEN 'lease:recoverable:' || n ELSE NULL END,
         CASE WHEN n % 10 IN (1, 2) THEN 1 ELSE NULL END,
         $3::timestamptz - (n || ' seconds')::interval,
         CASE WHEN n % 10 = 3 THEN $4::timestamptz ELSE $5::timestamptz END,
         CASE WHEN n % 10 IN (4, 5, 6) THEN $5::timestamptz ELSE NULL END
       FROM generate_series(1, $1::integer) AS series(n)`,
      [LIVE_TURN_SEED_COUNT, appId, now, freshAt, expiredAt],
    );
    await runtime.service.pool.query(`ANALYZE ${liveTurnsTable}`);
    await runtime.service.pool.query(`ANALYZE ${runLeasesTable}`);

    const counts = await runtime.service.pool.query<{
      table_cardinality: number | string;
      candidate_count: number | string;
      lost_owner_count: number | string;
      unleased_stale_count: number | string;
      healthy_leased_count: number | string;
      unleased_fresh_count: number | string;
      terminal_count: number | string;
    }>(
      `SELECT
         COUNT(*)::int AS table_cardinality,
         (COUNT(*) FILTER (
           WHERE state NOT IN ('completed', 'failed', 'timed_out')
             AND (
               (
                 run_id IS NOT NULL
                 AND lease_token IS NOT NULL
                 AND fencing_version IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM ${runLeasesTable}
                   WHERE ${runLeasesTable}.run_id = ${liveTurnsTable}.run_id
                     AND ${runLeasesTable}.status = 'active'
                     AND ${runLeasesTable}.expires_at > $1
                 )
               )
               OR (lease_token IS NULL AND updated_at <= $2)
             )
         ))::int AS candidate_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'live-turn:recoverable:%'
             AND run_id IS NOT NULL
             AND lease_token IS NOT NULL
             AND fencing_version IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM ${runLeasesTable}
               WHERE ${runLeasesTable}.run_id = ${liveTurnsTable}.run_id
                 AND ${runLeasesTable}.status = 'active'
                 AND ${runLeasesTable}.expires_at > $1
             )
         ))::int AS lost_owner_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'live-turn:recoverable:%'
             AND state NOT IN ('completed', 'failed', 'timed_out')
             AND lease_token IS NULL
             AND updated_at <= $2
         ))::int AS unleased_stale_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'live-turn:recoverable:%'
             AND run_id IS NOT NULL
             AND lease_token IS NOT NULL
             AND fencing_version IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM ${runLeasesTable}
               WHERE ${runLeasesTable}.run_id = ${liveTurnsTable}.run_id
                 AND ${runLeasesTable}.status = 'active'
                 AND ${runLeasesTable}.expires_at > $1
             )
         ))::int AS healthy_leased_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'live-turn:recoverable:%'
             AND state NOT IN ('completed', 'failed', 'timed_out')
             AND lease_token IS NULL
             AND updated_at > $2
         ))::int AS unleased_fresh_count,
         (COUNT(*) FILTER (
           WHERE id LIKE 'live-turn:recoverable:%'
             AND state IN ('completed', 'failed', 'timed_out')
         ))::int AS terminal_count
       FROM ${liveTurnsTable}`,
      [now, staleBefore],
    );
    const tableCardinality = Number(counts.rows[0]?.table_cardinality ?? 0);
    const candidateCount = Number(counts.rows[0]?.candidate_count ?? 0);
    expect(tableCardinality).toBeGreaterThanOrEqual(LIVE_TURN_SEED_COUNT);
    expect(candidateCount).toBeGreaterThan(RECOVERABLE_SWEEP_LIMIT);
    expect(Number(counts.rows[0]?.lost_owner_count ?? 0)).toBeGreaterThan(0);
    expect(Number(counts.rows[0]?.unleased_stale_count ?? 0)).toBeGreaterThan(
      0,
    );
    expect(Number(counts.rows[0]?.healthy_leased_count ?? 0)).toBeGreaterThan(
      0,
    );
    expect(Number(counts.rows[0]?.unleased_fresh_count ?? 0)).toBeGreaterThan(
      0,
    );
    expect(Number(counts.rows[0]?.terminal_count ?? 0)).toBeGreaterThan(0);

    const cases = [
      {
        name: 'lost_owner_branch',
        expectedIndex: 'idx_live_turns_recoverable_leased',
        sql: `SELECT id, updated_at
          FROM ${liveTurnsTable}
          WHERE state NOT IN ('completed', 'failed', 'timed_out')
            AND run_id IS NOT NULL
            AND lease_token IS NOT NULL
            AND fencing_version IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM ${runLeasesTable}
              WHERE ${runLeasesTable}.run_id = ${liveTurnsTable}.run_id
                AND ${runLeasesTable}.status = 'active'
                AND ${runLeasesTable}.expires_at > $1
            )
          ORDER BY updated_at ASC
          LIMIT $2`,
        values: [now, RECOVERABLE_SWEEP_CANDIDATE_LIMIT],
      },
      {
        name: 'unleased_stale_branch',
        expectedIndex: 'idx_live_turns_recoverable_unleased',
        sql: `SELECT id, updated_at
          FROM ${liveTurnsTable}
          WHERE state NOT IN ('completed', 'failed', 'timed_out')
            AND lease_token IS NULL
            AND updated_at <= $1
          ORDER BY updated_at ASC
          LIMIT $2`,
        values: [staleBefore, RECOVERABLE_SWEEP_CANDIDATE_LIMIT],
      },
    ];

    const plans = [];
    for (const item of cases) {
      const explain = await runtime.service.pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.sql}`,
        item.values,
      );
      const root = normalizeExplainPayload(explain.rows[0]?.['QUERY PLAN']);
      const scans = collectScanNodes(root.Plan);
      const actualRows = planNumber(root.Plan, 'Actual Rows') ?? 0;
      const scannedRows = scans.reduce(
        (total, scan) =>
          total +
          (Number(scan.actualRows ?? 0) +
            Number(scan.rowsRemovedByFilter ?? 0) +
            Number(scan.rowsRemovedByIndexRecheck ?? 0)) *
            Number(scan.actualLoops ?? 1),
        0,
      );
      const rowsScannedToReturnedRatio =
        actualRows > 0 ? scannedRows / actualRows : null;
      const observedIndexes = collectObservedIndexes(root.Plan);
      const observedNodeTypes = collectPlanNodeTypes(root.Plan);
      const usedSeqScan = scans.some(
        (scan) =>
          scan.relationName === 'live_turns' && scan.nodeType === 'Seq Scan',
      );
      const usedUnexpectedPlanNode = observedNodeTypes.some(
        (nodeType) => nodeType === 'Sort' || nodeType.startsWith('Bitmap'),
      );
      const verdict =
        usedSeqScan ||
        usedUnexpectedPlanNode ||
        !observedIndexes.includes(item.expectedIndex) ||
        rowsScannedToReturnedRatio === null ||
        rowsScannedToReturnedRatio > ROWS_SCANNED_TO_RETURNED_RATIO_GATE
          ? 'follow_up_required'
          : 'acceptable_evidence';
      plans.push({
        name: item.name,
        expectedIndex: item.expectedIndex,
        sql: item.sql,
        observedNodeTypes,
        observedIndexes,
        actualRows,
        rowsScannedToReturnedRatio,
        executionTimeMs: root['Execution Time'],
        scanNodes: scans,
        verdict,
      });
    }

    const repositoryResult =
      await runtime.repositories.liveTurns.listRecoverableLiveTurns({
        unleasedStaleBefore: staleBefore,
        limit: RECOVERABLE_SWEEP_LIMIT,
        now,
      });
    expect(repositoryResult).toHaveLength(RECOVERABLE_SWEEP_LIMIT);

    const artifact = {
      schemaVersion: 1,
      planName: 'recoverable_live_turn_sweep',
      benchmarkRunId: RECOVERABLE_SWEEP_RUN_ID,
      generatedAt: new Date().toISOString(),
      table: {
        schema: runtime.schemaName,
        name: 'live_turns',
        cardinality: tableCardinality,
      },
      counts: {
        candidateCount,
        lostOwnerCount: Number(counts.rows[0]?.lost_owner_count ?? 0),
        unleasedStaleCount: Number(counts.rows[0]?.unleased_stale_count ?? 0),
        healthyLeasedCount: Number(counts.rows[0]?.healthy_leased_count ?? 0),
        unleasedFreshCount: Number(counts.rows[0]?.unleased_fresh_count ?? 0),
        terminalCount: Number(counts.rows[0]?.terminal_count ?? 0),
      },
      limit: RECOVERABLE_SWEEP_LIMIT,
      candidateLimit: RECOVERABLE_SWEEP_CANDIDATE_LIMIT,
      rowsScannedToReturnedRatioGate: ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      cases: plans,
      verdict: {
        status: plans.every((item) => item.verdict === 'acceptable_evidence')
          ? 'acceptable_evidence'
          : 'follow_up_required',
      },
    };
    expect(artifact.table.cardinality).toBeGreaterThanOrEqual(
      LIVE_TURN_SEED_COUNT,
    );
    expect(artifact.counts.candidateCount).toBeGreaterThan(
      RECOVERABLE_SWEEP_LIMIT,
    );
    expect(artifact.verdict.status).toBe('acceptable_evidence');
    expect(artifact.cases).toHaveLength(cases.length);
    for (const item of artifact.cases) {
      expect(item.observedIndexes).toContain(item.expectedIndex);
      expect(item.observedNodeTypes).not.toContain('Sort');
      expect(item.rowsScannedToReturnedRatio).toBeLessThanOrEqual(
        ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      );
      expect(item.verdict).toBe('acceptable_evidence');
    }
  }, 120_000);
});
