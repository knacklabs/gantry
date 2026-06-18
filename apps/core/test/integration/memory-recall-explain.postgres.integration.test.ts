import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import { subjectIdFor } from '@core/memory/app-memory-boundaries.js';

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
const MEMORY_RECALL_RUN_ID = 'memory-recall-explain-itest';
const MEMORY_ITEM_COUNT = 100_000;
const MEMORY_EMBEDDING_COUNT = 100_000;
const RECALL_LIMIT = 20;
const HYBRID_CANDIDATE_LIMIT = 80;
const TIMING_SAMPLE_COUNT = 300;
const ROWS_SCANNED_TO_RETURNED_RATIO_GATE = 20;
const MEMORY_RECALL_DB_P95_GATE_MS = 200;
const APP_ID = 'default';
const AGENT_ID = 'agent-memory-hot-path';
const USER_ID = 'user-memory-hot-path';
const PROVIDER = 'openai';
const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;
const QUERY = 'launchalpha';

type QueryCase = {
  name: string;
  sql: string;
  values: unknown[];
  expectedIndexes: string[];
  vectorSettings?: boolean;
  filterEvidence?: Record<string, number>;
};

function quotedTable(
  runtime: PostgresIntegrationRuntime,
  table: string,
): string {
  return `${quotePostgresIdentifier(runtime.schemaName)}.${quotePostgresIdentifier(table)}`;
}

function vectorLiteral(activeDimension: 0 | 1): string {
  const values = new Array(DIMENSIONS).fill(0);
  values[activeDimension] = 1;
  return `[${values.join(',')}]`;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * p) - 1),
  );
  return Number(sorted[index]?.toFixed(2) ?? 0);
}

function timingSummary(values: number[]) {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Number(Math.max(...values).toFixed(2)),
  };
}

async function runQuery(
  runtime: PostgresIntegrationRuntime,
  item: QueryCase,
): Promise<void> {
  if (!item.vectorSettings) {
    await runtime.service.pool.query(item.sql, item.values);
    return;
  }
  const client = await runtime.service.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "select set_config('hnsw.iterative_scan', 'strict_order', true), set_config('hnsw.ef_search', '200', true)",
    );
    await client.query(item.sql, item.values);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function explainQuery(
  runtime: PostgresIntegrationRuntime,
  item: QueryCase,
) {
  if (!item.vectorSettings) {
    const explain = await runtime.service.pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.sql}`,
      item.values,
    );
    return normalizeExplainPayload(explain.rows[0]?.['QUERY PLAN']);
  }
  const client = await runtime.service.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "select set_config('hnsw.iterative_scan', 'strict_order', true), set_config('hnsw.ef_search', '200', true)",
    );
    const explain = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.sql}`,
      item.values,
    );
    return normalizeExplainPayload(explain.rows[0]?.['QUERY PLAN']);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

maybeDescribe('Postgres memory recall plans', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'memory_recall_explain',
    });
  }, 60_000);

  afterAll(async () => {
    if (!runtime) return;
    await runtime.cleanup();
  });

  it('writes memory recall EXPLAIN evidence at row volume', async () => {
    const memoryItemsTable = quotedTable(runtime, 'memory_items');
    const memoryEmbeddingsTable = quotedTable(
      runtime,
      'memory_item_embeddings',
    );
    const now = '2026-06-17T00:00:00.000Z';
    const commonSubjectId = subjectIdFor({
      appId: APP_ID,
      agentId: AGENT_ID,
      subjectType: 'common',
      subjectId: 'common',
    });
    const userSubjectId = subjectIdFor({
      appId: APP_ID,
      agentId: AGENT_ID,
      subjectType: 'user',
      subjectId: USER_ID,
      userId: USER_ID,
    });
    const closeVector = vectorLiteral(0);
    const farVector = vectorLiteral(1);

    await runtime.service.pool.query(
      `INSERT INTO ${memoryItemsTable} (
         id, app_id, agent_id, subject_type, subject_id, user_id,
         conversation_id, thread_id, kind, key, value_json, confidence,
         source_ref_json, status, last_observed_at, created_at, updated_at
       )
       SELECT
         'memory-hot-item-' || n,
         $2,
         $3,
         CASE
           WHEN n % 5000 IN (1, 2, 3, 4, 5, 6) THEN CASE WHEN n % 2 = 0 THEN 'user' ELSE 'common' END
           WHEN n % 4 = 0 THEN 'user'
           WHEN n % 4 = 1 THEN 'group'
           WHEN n % 4 = 2 THEN 'channel'
           ELSE 'user'
         END,
         CASE
           WHEN n % 5000 IN (1, 2, 3, 4, 5, 6) THEN CASE WHEN n % 2 = 0 THEN $5 ELSE $4 END
           ELSE 'other-memory-subject-' || (n % 5000)
         END,
         CASE
           WHEN n % 5000 IN (1, 2, 3, 4, 5, 6) AND n % 2 = 0 THEN $6
           WHEN n % 4 IN (0, 3) THEN 'other-user-' || (n % 5000)
           ELSE NULL
         END,
         CASE
           WHEN n % 4 = 2 THEN 'conversation:memory-hot-path'
           ELSE NULL
         END,
         NULL,
         'fact',
         CASE
             WHEN n % 5000 IN (1, 2) THEN 'launchalpha-key-' || n
             WHEN n % 5000 = 3 THEN 'semantic-close-stale-' || n
             WHEN n % 5000 = 4 THEN 'semantic-close-wrong-provider-' || n
             WHEN n % 5000 = 5 THEN 'semantic-close-wrong-model-' || n
             WHEN n % 5000 = 6 THEN 'semantic-close-wrong-dimension-' || n
           ELSE 'ordinary-memory-key-' || n
         END,
         jsonb_build_object(
           'value',
           CASE
             WHEN n % 5000 IN (1, 2) THEN 'launchalpha current synthetic value ' || n
             WHEN n % 5000 = 3 THEN 'semantic close stale synthetic value ' || n
             WHEN n % 5000 = 4 THEN 'semantic close wrong provider synthetic value ' || n
             WHEN n % 5000 = 5 THEN 'semantic close wrong model synthetic value ' || n
             WHEN n % 5000 = 6 THEN 'semantic close wrong dimension synthetic value ' || n
             ELSE 'ordinary synthetic memory value ' || n
           END,
           'why',
           CASE
             WHEN n % 5000 IN (1, 2) THEN 'row-volume recall evidence'
             ELSE NULL
           END
         ),
         0.9,
         jsonb_build_object('source', 'memory-recall-explain-itest'),
         CASE
           WHEN n % 5000 IN (1, 2, 3, 4, 5, 6) THEN 'active'
           WHEN n % 37 = 0 THEN 'inactive'
           ELSE 'active'
         END,
         $7::timestamptz - (n || ' seconds')::interval,
         $7::timestamptz - (n || ' seconds')::interval,
         $7::timestamptz - (n || ' seconds')::interval
       FROM generate_series(1, $1::integer) AS series(n)`,
      [
        MEMORY_ITEM_COUNT,
        APP_ID,
        AGENT_ID,
        commonSubjectId,
        userSubjectId,
        USER_ID,
        now,
      ],
    );

    await runtime.service.pool.query(
      `WITH item_rows AS (
         SELECT
           id,
           key,
           value_json,
           substring(id from 'memory-hot-item-(\\d+)')::integer AS n
         FROM ${memoryItemsTable}
         WHERE id LIKE 'memory-hot-item-%'
       ),
       hashed AS (
         SELECT
           *,
           encode(digest(key || E'\\n' || COALESCE(value_json->>'value', '') || E'\\n' || COALESCE(value_json->>'why', ''), 'sha256'), 'hex') AS current_hash
         FROM item_rows
       )
       INSERT INTO ${memoryEmbeddingsTable} (
         item_id, provider, model, content_hash, embedding_json, embedding,
         dimensions, status, attempt_count, last_attempt_at, resume_after,
         run_id, provider_batch_id, error, created_at, updated_at
       )
       SELECT
         id,
         CASE
           WHEN n % 5000 = 4 THEN 'other-provider'
           WHEN n % 5000 IN (1, 2, 3, 5, 6) THEN $3
           WHEN n % 100 = 1 THEN 'other-provider'
           ELSE $3
         END,
         CASE
           WHEN n % 5000 = 5 THEN 'other-model'
           WHEN n % 5000 IN (1, 2, 3, 4, 6) THEN $4
           WHEN n % 100 = 2 THEN 'other-model'
           ELSE $4
         END,
         CASE
           WHEN n % 5000 = 3 THEN 'stale-' || current_hash
           ELSE current_hash
         END,
         NULL,
         CASE
           WHEN n % 5000 IN (1, 2, 3, 4, 5, 6) THEN $6::vector
           WHEN n % 100 IN (0, 1, 2, 3) THEN $7::vector
           ELSE NULL
         END,
         CASE
           WHEN n % 5000 = 6 THEN 768
           WHEN n % 5000 IN (1, 2, 3, 4, 5) THEN $5
           WHEN n % 100 = 3 THEN 768
           ELSE $5
         END,
         CASE
           WHEN n % 5000 IN (1, 2, 3, 4, 5, 6) THEN 'ready'
           WHEN n % 100 IN (0, 1, 2, 3, 4) THEN 'ready'
           ELSE 'pending'
         END,
         0,
         $2::timestamptz,
         NULL,
         NULL,
         NULL,
         NULL,
         $2::timestamptz,
         $2::timestamptz
       FROM hashed
       LIMIT $1::integer`,
      [
        MEMORY_EMBEDDING_COUNT,
        now,
        PROVIDER,
        MODEL,
        DIMENSIONS,
        closeVector,
        farVector,
      ],
    );

    await runtime.service.pool.query(`ANALYZE ${memoryItemsTable}`);
    await runtime.service.pool.query(`ANALYZE ${memoryEmbeddingsTable}`);

    const itemCardinality = (
      await runtime.service.pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active,
           COUNT(*) FILTER (WHERE status <> 'active')::int AS inactive,
           COUNT(*) FILTER (WHERE subject_type = 'common')::int AS common,
           COUNT(*) FILTER (WHERE subject_type = 'user')::int AS users,
           COUNT(*) FILTER (WHERE subject_type = 'group')::int AS groups,
           COUNT(*) FILTER (WHERE subject_type = 'channel')::int AS channels,
           COUNT(*) FILTER (WHERE key LIKE 'launchalpha-key-%')::int AS lexical_targets
         FROM ${memoryItemsTable}`,
      )
    ).rows[0];
    const embeddingCardinality = (
      await runtime.service.pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'ready')::int AS ready,
           COUNT(*) FILTER (WHERE status <> 'ready')::int AS non_ready,
           COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS non_null_embeddings,
           COUNT(*) FILTER (WHERE embedding IS NULL)::int AS null_embeddings,
           COUNT(*) FILTER (WHERE provider <> $1)::int AS wrong_provider,
           COUNT(*) FILTER (WHERE model <> $2)::int AS wrong_model,
           COUNT(*) FILTER (WHERE dimensions <> $3)::int AS wrong_dimensions,
           COUNT(*) FILTER (WHERE content_hash LIKE 'stale-%')::int AS stale_content_hash
         FROM ${memoryEmbeddingsTable}`,
        [PROVIDER, MODEL, DIMENSIONS],
      )
    ).rows[0];

    expect(Number(itemCardinality.total)).toBeGreaterThanOrEqual(
      MEMORY_ITEM_COUNT,
    );
    expect(Number(embeddingCardinality.total)).toBeGreaterThanOrEqual(
      MEMORY_EMBEDDING_COUNT,
    );
    expect(Number(embeddingCardinality.stale_content_hash)).toBeGreaterThan(0);
    expect(Number(embeddingCardinality.wrong_provider)).toBeGreaterThan(0);
    expect(Number(embeddingCardinality.wrong_model)).toBeGreaterThan(0);
    expect(Number(embeddingCardinality.wrong_dimensions)).toBeGreaterThan(0);
    expect(Number(embeddingCardinality.null_embeddings)).toBeGreaterThan(0);
    expect(Number(embeddingCardinality.non_ready)).toBeGreaterThan(0);

    const document = `to_tsvector('english', i.key || ' ' || COALESCE(i.value_json->>'value', '') || ' ' || COALESCE(i.value_json->>'why', ''))`;
    const searchQuery = `plainto_tsquery('english', $3)`;
    const visible = `(
      (i.agent_id = $2 AND i.subject_type = 'common' AND i.subject_id = $4)
      OR (i.agent_id = $2 AND i.subject_type = 'user' AND i.subject_id = $5)
    )`;
    const currentContentHash = `encode(digest(i.key || E'\\n' || COALESCE(i.value_json->>'value', '') || E'\\n' || COALESCE(i.value_json->>'why', ''), 'sha256'), 'hex')`;
    const lexicalSql = `SELECT
         i.id,
         ts_rank_cd(${document}, ${searchQuery}) AS lexical_score,
         ((ts_rank_cd(${document}, ${searchQuery}) * 0.65) + (i.confidence * 0.10)) AS score
       FROM ${memoryItemsTable} i
       WHERE i.status = 'active'
         AND i.app_id = $1
         AND ${visible}
         AND ${document} @@ ${searchQuery}
       ORDER BY score DESC, i.updated_at DESC, i.key ASC, i.id ASC
       LIMIT $6`;
    const noQuerySql = `SELECT i.id
       FROM ${memoryItemsTable} i
       WHERE i.status = 'active'
         AND i.app_id = $1
         AND i.agent_id = $2
         AND i.subject_type = 'user'
         AND i.subject_id = $3
       ORDER BY i.updated_at DESC, i.key ASC, i.id ASC
       LIMIT $4`;
    const vectorSql = `SELECT
         i.id,
         emb.embedding <=> $8::vector AS distance
       FROM ${memoryEmbeddingsTable} emb
       INNER JOIN ${memoryItemsTable} i ON emb.item_id = i.id
       WHERE i.status = 'active'
         AND i.app_id = $1
         AND ${visible.replaceAll('$3', '$9')}
         AND emb.provider = $3
         AND emb.model = $6
         AND emb.dimensions = $7
         AND emb.status = 'ready'
         AND emb.embedding IS NOT NULL
         AND emb.content_hash = ${currentContentHash}
       ORDER BY emb.embedding <=> $8::vector ASC
       LIMIT $9`;
    const vectorValues = [
      APP_ID,
      AGENT_ID,
      PROVIDER,
      commonSubjectId,
      userSubjectId,
      MODEL,
      DIMENSIONS,
      closeVector,
      HYBRID_CANDIDATE_LIMIT,
    ];
    const vectorFilterValues = vectorValues.slice(0, 8);
    const visibleBadCandidates = (
      await runtime.service.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE emb.status = 'ready' AND emb.embedding IS NOT NULL AND (emb.embedding <=> $8::vector) <= 0.000001)::int AS visible_ready_close_embedding_rows,
           COUNT(*) FILTER (WHERE emb.status = 'ready' AND emb.embedding IS NOT NULL AND (emb.embedding <=> $8::vector) <= 0.000001 AND emb.content_hash LIKE 'stale-%')::int AS visible_stale_content_hash_rows,
           COUNT(*) FILTER (WHERE emb.status = 'ready' AND emb.embedding IS NOT NULL AND (emb.embedding <=> $8::vector) <= 0.000001 AND emb.provider <> $3)::int AS visible_wrong_provider_rows,
           COUNT(*) FILTER (WHERE emb.status = 'ready' AND emb.embedding IS NOT NULL AND (emb.embedding <=> $8::vector) <= 0.000001 AND emb.model <> $6)::int AS visible_wrong_model_rows,
           COUNT(*) FILTER (WHERE emb.status = 'ready' AND emb.embedding IS NOT NULL AND (emb.embedding <=> $8::vector) <= 0.000001 AND emb.dimensions <> $7)::int AS visible_wrong_dimensions_rows
         FROM ${memoryEmbeddingsTable} emb
         INNER JOIN ${memoryItemsTable} i ON emb.item_id = i.id
         WHERE i.status = 'active'
           AND i.app_id = $1
           AND ${visible}`,
        vectorFilterValues,
      )
    ).rows[0];
    const returnedBadRows = (
      await runtime.service.pool.query(
        `WITH returned AS (${vectorSql})
         SELECT
           COUNT(*)::int AS returned_rows,
           COUNT(*) FILTER (WHERE emb.content_hash LIKE 'stale-%')::int AS returned_stale_content_hash_rows,
           COUNT(*) FILTER (WHERE emb.provider <> $3)::int AS returned_wrong_provider_rows,
           COUNT(*) FILTER (WHERE emb.model <> $6)::int AS returned_wrong_model_rows,
           COUNT(*) FILTER (WHERE emb.dimensions <> $7)::int AS returned_wrong_dimensions_rows
         FROM returned r
         INNER JOIN ${memoryEmbeddingsTable} emb ON emb.item_id = r.id`,
        vectorValues,
      )
    ).rows[0];
    const vectorFilterEvidence = {
      visibleReadyCloseEmbeddingRows: Number(
        visibleBadCandidates.visible_ready_close_embedding_rows,
      ),
      visibleStaleContentHashRows: Number(
        visibleBadCandidates.visible_stale_content_hash_rows,
      ),
      visibleWrongProviderRows: Number(
        visibleBadCandidates.visible_wrong_provider_rows,
      ),
      visibleWrongModelRows: Number(
        visibleBadCandidates.visible_wrong_model_rows,
      ),
      visibleWrongDimensionsRows: Number(
        visibleBadCandidates.visible_wrong_dimensions_rows,
      ),
      returnedRows: Number(returnedBadRows.returned_rows),
      returnedStaleContentHashRows: Number(
        returnedBadRows.returned_stale_content_hash_rows,
      ),
      returnedWrongProviderRows: Number(
        returnedBadRows.returned_wrong_provider_rows,
      ),
      returnedWrongModelRows: Number(returnedBadRows.returned_wrong_model_rows),
      returnedWrongDimensionsRows: Number(
        returnedBadRows.returned_wrong_dimensions_rows,
      ),
    };
    expect(vectorFilterEvidence.visibleStaleContentHashRows).toBeGreaterThan(0);
    expect(vectorFilterEvidence.visibleWrongProviderRows).toBeGreaterThan(0);
    expect(vectorFilterEvidence.visibleWrongModelRows).toBeGreaterThan(0);
    expect(vectorFilterEvidence.visibleWrongDimensionsRows).toBeGreaterThan(0);
    expect(vectorFilterEvidence.returnedRows).toBeGreaterThan(0);
    expect(vectorFilterEvidence.returnedStaleContentHashRows).toBe(0);
    expect(vectorFilterEvidence.returnedWrongProviderRows).toBe(0);
    expect(vectorFilterEvidence.returnedWrongModelRows).toBe(0);
    expect(vectorFilterEvidence.returnedWrongDimensionsRows).toBe(0);

    const queryCases: QueryCase[] = [
      {
        name: 'lexical_ranked_recall',
        sql: lexicalSql,
        values: [
          APP_ID,
          AGENT_ID,
          QUERY,
          commonSubjectId,
          userSubjectId,
          RECALL_LIMIT,
        ],
        expectedIndexes: ['memory_items_active_unique'],
      },
      {
        name: 'lexical_embedding_fallback',
        sql: lexicalSql,
        values: [
          APP_ID,
          AGENT_ID,
          QUERY,
          commonSubjectId,
          userSubjectId,
          RECALL_LIMIT,
        ],
        expectedIndexes: ['memory_items_active_unique'],
      },
      {
        name: 'no_query_subject_updated',
        sql: noQuerySql,
        values: [APP_ID, AGENT_ID, userSubjectId, RECALL_LIMIT],
        expectedIndexes: ['idx_memory_items_subject_updated'],
      },
      {
        name: 'hybrid_lexical_candidates',
        sql: lexicalSql,
        values: [
          APP_ID,
          AGENT_ID,
          QUERY,
          commonSubjectId,
          userSubjectId,
          HYBRID_CANDIDATE_LIMIT,
        ],
        expectedIndexes: ['memory_items_active_unique'],
      },
      {
        name: 'hybrid_vector_candidates',
        sql: vectorSql,
        values: vectorValues,
        expectedIndexes: [
          'memory_items_active_unique',
          'idx_memory_item_embeddings_item',
        ],
        vectorSettings: true,
      },
      {
        name: 'stale_vector_filtered',
        sql: vectorSql,
        values: vectorValues,
        expectedIndexes: [
          'memory_items_active_unique',
          'idx_memory_item_embeddings_item',
        ],
        vectorSettings: true,
        filterEvidence: {
          visibleStaleContentHashRows:
            vectorFilterEvidence.visibleStaleContentHashRows,
          returnedStaleContentHashRows:
            vectorFilterEvidence.returnedStaleContentHashRows,
        },
      },
      {
        name: 'provider_model_dimension_filtered',
        sql: vectorSql,
        values: vectorValues,
        expectedIndexes: [
          'memory_items_active_unique',
          'idx_memory_item_embeddings_item',
        ],
        vectorSettings: true,
        filterEvidence: {
          visibleWrongProviderRows:
            vectorFilterEvidence.visibleWrongProviderRows,
          visibleWrongModelRows: vectorFilterEvidence.visibleWrongModelRows,
          visibleWrongDimensionsRows:
            vectorFilterEvidence.visibleWrongDimensionsRows,
          returnedWrongProviderRows:
            vectorFilterEvidence.returnedWrongProviderRows,
          returnedWrongModelRows: vectorFilterEvidence.returnedWrongModelRows,
          returnedWrongDimensionsRows:
            vectorFilterEvidence.returnedWrongDimensionsRows,
        },
      },
    ];

    const plans = [];
    for (const item of queryCases) {
      const root = await explainQuery(runtime, item);
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
        actualRows > 0 ? Number((scannedRows / actualRows).toFixed(2)) : null;
      const observedIndexes = collectObservedIndexes(root.Plan);
      const observedNodeTypes = collectPlanNodeTypes(root.Plan);
      const planIndexUsed = item.expectedIndexes.every((indexName) =>
        observedIndexes.includes(indexName),
      );
      const usedMemorySeqScan = scans.some(
        (scan) =>
          (scan.relationName === 'memory_items' ||
            scan.relationName === 'memory_item_embeddings') &&
          scan.nodeType === 'Seq Scan',
      );
      const ratioAcceptable =
        rowsScannedToReturnedRatio !== null &&
        rowsScannedToReturnedRatio <= ROWS_SCANNED_TO_RETURNED_RATIO_GATE;
      const verdict =
        planIndexUsed && ratioAcceptable && !usedMemorySeqScan
          ? 'acceptable_evidence'
          : 'follow_up_required';
      plans.push({
        name: item.name,
        expectedIndexes: item.expectedIndexes,
        observedIndexes,
        observedNodeTypes,
        planIndexUsed,
        actualRows,
        rowsScannedToReturnedRatio,
        rowsScannedToReturnedRatioGate: ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
        planningTimeMs: root['Planning Time'],
        executionTimeMs: root['Execution Time'],
        scanNodes: scans,
        filterEvidence: item.filterEvidence,
        sql: item.sql,
        verdict,
      });
    }

    const timedCases = [queryCases[0]!, queryCases[2]!, queryCases[4]!];
    const timingSamples = [];
    for (let index = 0; index < TIMING_SAMPLE_COUNT; index += 1) {
      const item = timedCases[index % timedCases.length]!;
      const startedAt = performance.now();
      await runQuery(runtime, item);
      timingSamples.push({
        name: item.name,
        ms: Number((performance.now() - startedAt).toFixed(2)),
      });
    }
    const allTimingMs = timingSamples.map((sample) => sample.ms);
    const timing = {
      memoryRecallDbMs: timingSummary(allTimingMs),
      byQuery: Object.fromEntries(
        timedCases.map((item) => [
          item.name,
          timingSummary(
            timingSamples
              .filter((sample) => sample.name === item.name)
              .map((sample) => sample.ms),
          ),
        ]),
      ),
      gateMs: MEMORY_RECALL_DB_P95_GATE_MS,
      evidenceSource: 'benchmark_observed_db_only',
    };
    const allPlansAcceptable = plans.every(
      (plan) => plan.verdict === 'acceptable_evidence',
    );
    const timingAcceptable =
      timing.memoryRecallDbMs.p95 <= MEMORY_RECALL_DB_P95_GATE_MS;
    const artifact = {
      benchmarkRunId: MEMORY_RECALL_RUN_ID,
      generatedAt: new Date().toISOString(),
      rowVolume: {
        memoryItems: itemCardinality,
        memoryItemEmbeddings: embeddingCardinality,
        configuredMemoryItemCount: MEMORY_ITEM_COUNT,
        configuredMemoryEmbeddingCount: MEMORY_EMBEDDING_COUNT,
      },
      metricGates: {
        memoryRecallDbMsP95Ms: MEMORY_RECALL_DB_P95_GATE_MS,
        rowsScannedToReturnedRatio: ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      },
      timing,
      plans,
      filterEvidence: vectorFilterEvidence,
      indexDecisions: [
        {
          index: 'memory_items_active_unique',
          decision: 'existing_index_sufficient',
          reason:
            'observed for seeded lexical and hybrid visible-subject candidate plans',
        },
        {
          index: 'idx_memory_items_search',
          decision: 'not_observed_no_new_index',
          reason:
            'lexical recall passed through the existing active subject/key path at seeded visible-subject cardinality; no broader text index was justified by this evidence',
        },
        {
          index: 'idx_memory_items_subject_updated',
          decision: 'existing_index_sufficient',
          reason:
            'existing subject/update index was the expected no-query plan',
        },
        {
          index: 'idx_memory_item_embeddings_item',
          decision: 'existing_index_sufficient',
          reason:
            'observed for filtered vector lookup joined through bounded visible memory items',
        },
        {
          index: 'idx_memory_item_embeddings_hnsw',
          decision: 'not_observed_no_new_index',
          reason:
            'filtered vector recall passed through the existing item lookup path at seeded visible-subject cardinality; no additional vector index was justified by this evidence',
        },
        {
          index: 'idx_memory_item_embeddings_ready_lookup',
          decision: 'not_observed_no_new_index',
          reason:
            'filtered vector recall passed through the existing item lookup path at seeded visible-subject cardinality',
        },
      ],
      verdict: {
        status:
          allPlansAcceptable && timingAcceptable
            ? 'acceptable_evidence'
            : 'follow_up_required',
        allPlansAcceptable,
        timingAcceptable,
      },
      redaction: {
        rawMemoryValuesIncluded: false,
        rawEmbeddingVectorsIncluded: false,
        databaseUrlIncluded: false,
      },
    };

    expect(artifact.verdict.status).toBe('acceptable_evidence');
    const artifactText = JSON.stringify(artifact);
    expect(artifactText).not.toContain('ordinary synthetic memory');
    expect(artifactText).not.toContain('launchalpha current');
    if (process.env.GANTRY_TEST_DATABASE_URL) {
      expect(artifactText).not.toContain(process.env.GANTRY_TEST_DATABASE_URL);
    }
  }, 240_000);
});
