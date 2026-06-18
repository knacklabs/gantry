import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  AgentSessionId,
  ExecutionProviderId,
  ProviderSessionId,
} from '@core/domain/sessions/sessions.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import {
  collectBufferFields,
  collectObservedIndexes,
  collectPlanNodes,
  collectScanNodes,
  normalizeExplainPayload,
  planNumber,
  sumBuffers,
  type ScanNodeEvidence,
} from '../harness/postgres-explain.js';

const maybeDescribe =
  hasPostgresIntegrationDatabase && process.env.GANTRY_POSTGRES_HOT_PATH === '1'
    ? describe
    : describe.skip;
const ROWS_SCANNED_TO_RETURNED_RATIO_GATE = 20;

const LIVE_ADMISSION_EXPLAIN_RUN_ID = 'live-admission-claim-explain-itest';
const LIVE_ADMISSION_SEED_COUNT = 100_000;
const LIVE_ADMISSION_EXPLAIN_LIMIT = 25;
const LIVE_ADMISSION_EXPLAIN_CANDIDATE_LIMIT = LIVE_ADMISSION_EXPLAIN_LIMIT * 4;
const LIVE_ADMISSION_EXPECTED_BRANCH_INDEXES = [
  'idx_live_admission_work_items_queued_fifo',
  'idx_live_admission_work_items_deferred_due',
  'idx_live_admission_work_items_deferred_null_fifo',
  'idx_live_admission_work_items_claimed_expired',
] as const;

const PROVIDER_SESSION_EXPLAIN_RUN_ID =
  'provider-session-resume-write-explain-itest';
const PROVIDER_SESSION_EXECUTION_PROVIDER_ID =
  'anthropic:claude-agent-sdk' as ExecutionProviderId;
const PROVIDER_SESSION_AGENT_COUNT = 50_000;
const PROVIDER_SESSION_ROW_COUNT = 100_000;
const PROVIDER_SESSION_TARGET_COUNT = 300;
const PROVIDER_SESSION_DISTRACTOR_COUNT = 200;

maybeDescribe('Postgres hot-path EXPLAIN plans', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'postgres_hot_path_explain',
    });
  }, 60_000);

  afterAll(async () => {
    if (!runtime) return;
    await runtime.cleanup();
  });

  it('writes rollback-only live admission claim EXPLAIN evidence at row volume', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    const now = new Date().toISOString();
    const tableName = quotedTable(runtime, 'live_admission_work_items');
    const candidateSql = liveAdmissionClaimExplainSql(tableName);

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
    expect(tableCardinality).toBeGreaterThanOrEqual(LIVE_ADMISSION_SEED_COUNT);
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
      },
      plan: explainRoot,
    };

    expect(artifact).toMatchObject({
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
    expect(artifact.sql).toContain("state = 'queued'");
    expect(artifact.sql).toContain("state = 'deferred'");
    expect(artifact.sql).toContain("state = 'claimed'");
    expect(artifact.sql).toContain('app_id = $4');
    expect(artifact.sql).toContain('UNION ALL');
    expect(artifact.sql).toContain(
      'ORDER BY app_id ASC, created_at ASC, id ASC',
    );
    expect(artifact.sql).toContain('LIMIT $2');
    expect(artifact.sql).toContain('FOR UPDATE SKIP LOCKED');
    for (const indexName of LIVE_ADMISSION_EXPECTED_BRANCH_INDEXES) {
      expect(artifact.observedIndexes).toContain(indexName);
    }
    expect(artifact.scanNodes.length).toBeGreaterThan(0);
    expect(artifact.rowsScannedToReturnedRatio).toEqual(expect.any(Number));
    expect(artifact.rowsScannedToReturnedRatio).toBeLessThanOrEqual(
      artifact.rowsScannedToReturnedRatioGate,
    );
    expect(
      artifact.planNodes.some(
        (node: {
          nodeType?: string;
          actualRows?: number;
          actualLoops?: number;
        }) =>
          node.nodeType === 'Sort' &&
          (node.actualRows ?? 0) * (node.actualLoops ?? 1) >
            artifact.limit * LIVE_ADMISSION_EXPECTED_BRANCH_INDEXES.length,
      ),
    ).toBe(false);
    expect(
      artifact.scanNodes.some(
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
            artifact.limit * artifact.rowsScannedToReturnedRatioGate
          );
        },
      ),
    ).toBe(false);
    expect(artifact.verdict.status).toBe('acceptable_evidence');
    expect(typeof artifact.executionTimeMs).toBe('number');
    expect(Object.keys(artifact.buffers).length).toBeGreaterThan(0);
  });

  it('writes provider-session resume/write EXPLAIN evidence at row volume', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    const agentTableName = quotedTable(runtime, 'agent_sessions');
    const providerTableName = quotedTable(runtime, 'provider_sessions');

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
      PROVIDER_SESSION_AGENT_COUNT + PROVIDER_SESSION_TARGET_COUNT,
    );
    expect(providerSessionCount).toBeGreaterThanOrEqual(
      PROVIDER_SESSION_ROW_COUNT + PROVIDER_SESSION_TARGET_COUNT * 2,
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
        values: [targetAgentSessionId, PROVIDER_SESSION_EXECUTION_PROVIDER_ID],
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
          PROVIDER_SESSION_EXECUTION_PROVIDER_ID,
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

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      planName: 'provider_session_resume_write',
      benchmarkRunId: PROVIDER_SESSION_EXPLAIN_RUN_ID,
      verdict: { status: 'acceptable_evidence' },
    });
    expect(artifact.cases).toHaveLength(cases.length);
    for (const item of artifact.cases) {
      expect(item.observedIndexes).toContain(item.expectedIndex);
      expect(item.rowsScannedToReturnedRatio).toBeLessThanOrEqual(
        ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      );
      expect(item.verdict).toBe('acceptable_evidence');
    }
  });
});

function quotedTable(
  runtime: PostgresIntegrationRuntime,
  tableName: string,
): string {
  return `${quotePostgresIdentifier(runtime.schemaName)}.${quotePostgresIdentifier(tableName)}`;
}

function providerReadAgentSessionId(index: number): AgentSessionId {
  return `${PROVIDER_SESSION_EXPLAIN_RUN_ID}:provider-read-agent-session:${index}` as AgentSessionId;
}

function providerReadSessionId(index: number): ProviderSessionId {
  return `${PROVIDER_SESSION_EXPLAIN_RUN_ID}:provider-read-session:${index}:current` as ProviderSessionId;
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
    [PROVIDER_SESSION_AGENT_COUNT, appId, DEFAULT_AGENT_ID],
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
      PROVIDER_SESSION_AGENT_COUNT,
      appId,
      PROVIDER_SESSION_EXECUTION_PROVIDER_ID,
      'deepagents:langchain',
      PROVIDER_SESSION_ROW_COUNT,
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
    [
      appId,
      DEFAULT_AGENT_ID,
      PROVIDER_SESSION_TARGET_COUNT,
      PROVIDER_SESSION_EXPLAIN_RUN_ID,
    ],
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
       jsonb_build_object('seed', 'provider-session-read-target'),
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
       jsonb_build_object('seed', 'provider-session-read-target'),
       'active',
       '2026-06-17T00:00:00.000Z'::timestamptz,
       '2026-06-17T00:00:00.000Z'::timestamptz + (n || ' milliseconds')::interval
     FROM generate_series(0, $4::integer - 1) AS series(n)
     ON CONFLICT (id) DO NOTHING`,
    [
      appId,
      PROVIDER_SESSION_EXECUTION_PROVIDER_ID,
      'deepagents:langchain',
      PROVIDER_SESSION_TARGET_COUNT,
      PROVIDER_SESSION_EXPLAIN_RUN_ID,
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
       jsonb_build_object('seed', 'provider-session-index-distractor'),
       'active',
       '2026-06-17T00:00:00.000Z'::timestamptz,
       '2026-06-18T00:00:00.000Z'::timestamptz + (n || ' milliseconds')::interval
     FROM generate_series(1, $3::integer) AS series(n)
     ON CONFLICT (id) DO NOTHING`,
    [
      appId,
      'deepagents:langchain',
      PROVIDER_SESSION_DISTRACTOR_COUNT,
      PROVIDER_SESSION_EXPLAIN_RUN_ID,
    ],
  );
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
       'conversation:live-admission-hot-path:' || (n % 300),
       NULL,
       'conversation:live-admission-hot-path:' || (n % 300),
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
    [LIVE_ADMISSION_SEED_COUNT, appId, DEFAULT_AGENT_ID],
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

function sumScanRowsRemoved(scanNodes: ScanNodeEvidence[]): number {
  return scanNodes.reduce(
    (total, node) => total + (node.rowsRemovedByFilter ?? 0),
    0,
  );
}
