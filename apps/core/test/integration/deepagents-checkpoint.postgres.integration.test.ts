import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import {
  createDeepAgentCheckpointTiming,
  createDeepAgentCheckpointSaverFromPool,
  type DeepAgentCheckpointSaver,
  DeepAgentSessionStore,
  MISSING_DEEPAGENTS_SESSION_MARKER,
} from '@core/adapters/llm/deepagents-langchain/runner/session-store.js';
import { ensureDeepAgentsCheckpointSchema } from '@core/adapters/llm/deepagents-langchain/checkpoint-setup.js';

import {
  collectBufferFields,
  collectObservedIndexes,
  collectPlanNodes,
  collectScanNodes,
  normalizeExplainPayload,
  planNumber,
  redactExplainPlan,
  redactSqlWhitespace,
  sumBuffers,
} from '../harness/postgres-explain.js';

const databaseUrl = process.env.GANTRY_TEST_DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;
const schema = `gantry_deepagents_it_${process.pid}`;
const pool = databaseUrl
  ? new pg.Pool({ connectionString: databaseUrl })
  : null;
const ROW_VOLUME_THREAD_COUNT = 10_000;
const ROW_VOLUME_SAMPLE_COUNT = 300;
const ROW_VOLUME_SEED_CONCURRENCY = 24;
const ROW_VOLUME_SAMPLE_CONCURRENCY = 24;
const CHECKPOINT_TIMING_GATE_MS = 250;
const ROWS_SCANNED_TO_RETURNED_RATIO_GATE = 20;
const CHECKPOINT_BENCHMARK_RUN_ID = 'deepagents-checkpoint-postgres-itest';
const CHECKPOINT_NS = '';

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

maybeDescribe(
  'DeepAgentSessionStore Postgres checkpoint integration',
  {
    timeout: 180_000,
  },
  () => {
    beforeAll(async () => {
      await pool?.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      await ensureDeepAgentsCheckpointSchema({
        databaseUrl: databaseUrl ?? '',
        schema,
      });
    });

    afterAll(async () => {
      await pool?.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      await pool?.end();
    });

    it('persists and resumes checkpoint state through the official PostgresSaver', async () => {
      const timing = createDeepAgentCheckpointTiming({
        nowMs: () => Date.now(),
      });
      const store = new DeepAgentSessionStore(
        {
          databaseUrl: databaseUrl ?? '',
          schema,
        },
        timing,
      );
      const sessionId = store.newSessionId();
      const saver = await store.create(sessionId);
      await saver.put(
        { configurable: { thread_id: sessionId } },
        {
          v: 4,
          ts: new Date(0).toISOString(),
          id: 'checkpoint-1',
          channel_values: {
            messages: [{ role: 'human', content: 'hello from postgres' }],
          },
          channel_versions: { messages: 1 },
          versions_seen: {},
          pending_sends: [],
        },
        {},
        { messages: 1 },
      );
      await saver.end();

      const loaded = await store.load(sessionId);
      const tuple = await loaded.getTuple({
        configurable: { thread_id: sessionId },
      });
      await loaded.end();

      expect(tuple?.checkpoint.channel_values.messages).toEqual([
        { role: 'human', content: 'hello from postgres' },
      ]);
      expect(timing.snapshot()).toEqual(
        expect.objectContaining({
          loadCount: 2,
          loadMs: expect.any(Number),
          writeCount: 1,
          writeMs: expect.any(Number),
        }),
      );
    });

    it('writes official PostgresSaver row-volume evidence at 10k checkpoint threads', async () => {
      if (process.env.GANTRY_POSTGRES_HOT_PATH !== '1') return;
      if (!pool || !databaseUrl) {
        throw new Error('GANTRY_TEST_DATABASE_URL is required');
      }
      const checkpointTables = {
        checkpoint_migrations: tableRef(schema, 'checkpoint_migrations'),
        checkpoints: tableRef(schema, 'checkpoints'),
        checkpoint_blobs: tableRef(schema, 'checkpoint_blobs'),
        checkpoint_writes: tableRef(schema, 'checkpoint_writes'),
      };
      await seedCheckpointRowVolume({
        databaseUrl,
        schema,
        threadCount: ROW_VOLUME_THREAD_COUNT,
      });
      for (const tableName of Object.values(checkpointTables)) {
        await pool.query(`ANALYZE ${tableName}`);
      }

      const tableInventory = await loadCheckpointTableInventory(pool, schema);
      expect(
        tableInventory.tables.checkpoints.cardinality,
      ).toBeGreaterThanOrEqual(ROW_VOLUME_THREAD_COUNT);
      expect(
        tableInventory.tables.checkpoint_blobs.cardinality,
      ).toBeGreaterThanOrEqual(ROW_VOLUME_THREAD_COUNT);
      expect(
        tableInventory.tables.checkpoint_writes.cardinality,
      ).toBeGreaterThanOrEqual(ROW_VOLUME_THREAD_COUNT);

      const sampleIndexes = Array.from(
        { length: ROW_VOLUME_SAMPLE_COUNT },
        (_, index) => index,
      );
      const largePayloadSamples = [0, 1, 2, 3, 4];
      const loadSamples = await mapWithConcurrency(
        sampleIndexes,
        ROW_VOLUME_SAMPLE_CONCURRENCY,
        async (sampleIndex) => {
          const store = new DeepAgentSessionStore({ databaseUrl, schema });
          const sessionId = checkpointThreadId(sampleIndex);
          return measureMs(async () => {
            const saver = await store.load(sessionId);
            await saver.end();
          });
        },
      );
      const writeSamples = await mapWithConcurrency(
        sampleIndexes,
        ROW_VOLUME_SAMPLE_CONCURRENCY,
        async (sampleIndex) => {
          const store = new DeepAgentSessionStore({ databaseUrl, schema });
          const sessionId = checkpointThreadId(sampleIndex);
          const checkpointId = measuredCheckpointId(sampleIndex);
          return measureMs(async () => {
            const saver = await store.create(sessionId);
            try {
              const config = await saver.put(
                {
                  configurable: {
                    thread_id: sessionId,
                    checkpoint_ns: CHECKPOINT_NS,
                    checkpoint_id: seedCheckpointId(sampleIndex),
                  },
                },
                checkpointPayload({
                  index: sampleIndex,
                  checkpointId,
                  largePayload: sampleIndex < largePayloadSamples.length,
                  generation: 2,
                }),
                { source: 'row-volume-measured' },
                checkpointVersions(sampleIndex, 2),
              );
              await saver.putWrites(
                config,
                [['messages', { status: 'measured', sample: sampleIndex }]],
                `task-measured-${sampleIndex}`,
              );
            } finally {
              await saver.end();
            }
          });
        },
      );
      const missingLoadSamples = await mapWithConcurrency(
        sampleIndexes.slice(0, 30),
        ROW_VOLUME_SAMPLE_CONCURRENCY,
        async (sampleIndex) => {
          const store = new DeepAgentSessionStore({ databaseUrl, schema });
          return measureMs(async () => {
            await expect(
              store.load(`missing-row-volume-${sampleIndex}`),
            ).rejects.toThrow(MISSING_DEEPAGENTS_SESSION_MARKER);
          });
        },
      );
      const largePayloadLoadSamples = await mapWithConcurrency(
        largePayloadSamples,
        largePayloadSamples.length,
        async (sampleIndex) => {
          const store = new DeepAgentSessionStore({ databaseUrl, schema });
          return measureMs(async () => {
            const saver = await store.load(checkpointThreadId(sampleIndex));
            try {
              const tuple = await saver.getTuple({
                configurable: { thread_id: checkpointThreadId(sampleIndex) },
              });
              expect(
                JSON.stringify(tuple?.checkpoint.channel_values),
              ).toContain('large-payload-');
            } finally {
              await saver.end();
            }
          });
        },
      );

      for (const tableName of Object.values(checkpointTables)) {
        await pool.query(`ANALYZE ${tableName}`);
      }
      const refreshedInventory = await loadCheckpointTableInventory(
        pool,
        schema,
      );
      const targetThreadId = checkpointThreadId(0);
      const targetSeedCheckpointId = seedCheckpointId(0);
      const targetMeasuredCheckpointId = measuredCheckpointId(0);
      const explainCases = [
        {
          name: 'latest_checkpoint_read',
          expectedIndexes: [
            'checkpoints_pkey',
            'checkpoint_blobs_pkey',
            'checkpoint_writes_pkey',
          ],
          sql: checkpointSelectSql(schema, {
            where:
              'WHERE thread_id = $1 AND checkpoint_ns = $2 ORDER BY checkpoint_id DESC LIMIT 1',
          }),
          values: [targetThreadId, CHECKPOINT_NS],
        },
        {
          name: 'exact_checkpoint_read',
          expectedIndexes: [
            'checkpoints_pkey',
            'checkpoint_blobs_pkey',
            'checkpoint_writes_pkey',
          ],
          sql: checkpointSelectSql(schema, {
            where:
              'WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3',
          }),
          values: [targetThreadId, CHECKPOINT_NS, targetMeasuredCheckpointId],
        },
        {
          name: 'checkpoint_blob_lookup',
          expectedIndexes: ['checkpoint_blobs_pkey'],
          sql: `SELECT bl.channel, bl.type, bl.blob IS NOT NULL AS has_blob
              FROM jsonb_each_text($3::jsonb) version_map
              INNER JOIN ${checkpointTables.checkpoint_blobs} bl
                ON bl.thread_id = $1
                AND bl.checkpoint_ns = $2
                AND bl.channel = version_map.key
                AND bl.version = version_map.value`,
          values: [
            targetThreadId,
            CHECKPOINT_NS,
            JSON.stringify(checkpointVersions(0, 2)),
          ],
        },
        {
          name: 'checkpoint_write_upsert',
          expectedIndexes: ['checkpoints_pkey'],
          sql: `INSERT INTO ${checkpointTables.checkpoints}
                (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id)
              DO UPDATE SET
                checkpoint = EXCLUDED.checkpoint,
                metadata = EXCLUDED.metadata
              RETURNING checkpoint_id`,
          values: [
            targetThreadId,
            CHECKPOINT_NS,
            'explain-checkpoint-write-upsert',
            targetSeedCheckpointId,
            checkpointPayload({
              index: 0,
              checkpointId: 'explain-checkpoint-write-upsert',
            }),
            { source: 'row-volume-explain' },
          ],
        },
        {
          name: 'checkpoint_blob_upsert',
          expectedIndexes: ['checkpoint_blobs_pkey'],
          sql: `INSERT INTO ${checkpointTables.checkpoint_blobs}
                (thread_id, checkpoint_ns, channel, version, type, blob)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (thread_id, checkpoint_ns, channel, version) DO NOTHING
              RETURNING channel`,
          values: [
            targetThreadId,
            CHECKPOINT_NS,
            'messages',
            'explain-version',
            'json',
            Buffer.from('"redacted"'),
          ],
        },
        {
          name: 'checkpoint_writes_upsert',
          expectedIndexes: ['checkpoint_writes_pkey'],
          sql: `INSERT INTO ${checkpointTables.checkpoint_writes}
                (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
              DO UPDATE SET
                channel = EXCLUDED.channel,
                type = EXCLUDED.type,
                blob = EXCLUDED.blob
              RETURNING checkpoint_id`,
          values: [
            targetThreadId,
            CHECKPOINT_NS,
            targetMeasuredCheckpointId,
            'task-explain-0',
            0,
            'messages',
            'json',
            Buffer.from('"redacted"'),
          ],
        },
      ];

      const explainPlans = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const item of explainCases) {
          const explain = await client.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.sql}`,
            item.values,
          );
          const root = normalizeExplainPayload(explain.rows[0]?.['QUERY PLAN']);
          const redactedRoot = redactExplainPlan(root);
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
            scanNodes.length === 0
              ? 0
              : actualRows > 0
                ? scannedRows / actualRows
                : null;
          const usedSeqScan = scanNodes.some(
            (node) =>
              node.nodeType === 'Seq Scan' &&
              Object.keys(checkpointTables).includes(node.relationName ?? ''),
          );
          const observedExpectedIndex = item.expectedIndexes.every(
            (indexName) => observedIndexes.includes(indexName),
          );
          const verdict =
            usedSeqScan ||
            !observedExpectedIndex ||
            rowsScannedToReturnedRatio === null ||
            rowsScannedToReturnedRatio > ROWS_SCANNED_TO_RETURNED_RATIO_GATE
              ? 'follow_up_required'
              : 'acceptable_evidence';
          explainPlans.push({
            name: item.name,
            expectedIndexes: item.expectedIndexes,
            sql: redactSqlWhitespace(item.sql),
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
            verdict,
            plan: redactedRoot,
          });
        }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }

      const checkpointLoadMs = summarizeTiming(loadSamples);
      const checkpointWriteMs = summarizeTiming(writeSamples);
      const verdictStatus = explainPlans.some(
        (item) => item.verdict !== 'acceptable_evidence',
      )
        ? 'follow_up_required'
        : 'acceptable_evidence';
      const artifact = {
        schemaVersion: 1,
        planName: 'deepagents_checkpoint_postgres_saver',
        benchmarkRunId: CHECKPOINT_BENCHMARK_RUN_ID,
        generatedAt: new Date().toISOString(),
        setup: {
          schema,
          usedEnsureDeepAgentsCheckpointSchema: true,
          saverConstruction: 'new PostgresSaver(pool, undefined, { schema })',
        },
        rowVolume: {
          threadCount: ROW_VOLUME_THREAD_COUNT,
          sampleCount: ROW_VOLUME_SAMPLE_COUNT,
          seedConcurrency: ROW_VOLUME_SEED_CONCURRENCY,
          sampleConcurrency: ROW_VOLUME_SAMPLE_CONCURRENCY,
        },
        planEvidenceScope:
          'representative_sql_matching_installed_package_schema_and_method_shapes',
        redaction: {
          rawCheckpointBodiesIncluded: false,
          rawMessageContentIncluded: false,
          databaseUrlIncluded: false,
          planLiteralValuesIncluded: false,
        },
        payloadShape: {
          smallPayloadBytes: checkpointPayloadBytes(
            checkpointPayload({
              index: 1,
              checkpointId: seedCheckpointId(1),
            }),
          ),
          largePayloadBytes: checkpointPayloadBytes(
            checkpointPayload({
              index: 0,
              checkpointId: seedCheckpointId(0),
              largePayload: true,
            }),
          ),
        },
        tables: refreshedInventory.tables,
        indexes: refreshedInventory.indexes,
        metrics: {
          checkpointLoadMs: {
            ...checkpointLoadMs,
            source: 'benchmark_observed',
            gateP95Ms: CHECKPOINT_TIMING_GATE_MS,
          },
          checkpointWriteMs: {
            ...checkpointWriteMs,
            source: 'benchmark_observed',
            gateP95Ms: CHECKPOINT_TIMING_GATE_MS,
          },
          missingCheckpointLoadMs: {
            ...summarizeTiming(missingLoadSamples),
            source: 'benchmark_observed',
          },
          largePayloadCheckpointLoadMs: {
            ...summarizeTiming(largePayloadLoadSamples),
            source: 'benchmark_observed',
          },
        },
        plans: explainPlans,
        verdict: {
          status: verdictStatus,
          reason:
            verdictStatus === 'acceptable_evidence'
              ? 'Official PostgresSaver method timings stayed within the 10k-thread gate, and representative package-schema read/upsert plans were primary-key backed.'
              : 'Official PostgresSaver checkpoint evidence needs follow-up before launch readiness.',
        },
      };

      const artifactText = JSON.stringify(artifact);
      expect(artifactText).not.toContain(databaseUrl);
      expect(artifactText).not.toContain('checkpoint-message-');
      expect(artifactText).not.toContain('large-payload-');
      expect(artifactText).not.toContain('checkpoint-thread-');
      expect(artifactText).not.toContain('seed-checkpoint-');
      expect(artifactText).not.toContain('write-checkpoint-');
      expect(artifactText).not.toContain('explain-checkpoint-');
      expect(artifactText).not.toContain('task-explain-');
      expect(artifact).toMatchObject({
        schemaVersion: 1,
        planName: 'deepagents_checkpoint_postgres_saver',
        benchmarkRunId: CHECKPOINT_BENCHMARK_RUN_ID,
        rowVolume: {
          threadCount: ROW_VOLUME_THREAD_COUNT,
          sampleCount: ROW_VOLUME_SAMPLE_COUNT,
        },
        planEvidenceScope:
          'representative_sql_matching_installed_package_schema_and_method_shapes',
        redaction: {
          rawCheckpointBodiesIncluded: false,
          rawMessageContentIncluded: false,
          databaseUrlIncluded: false,
          planLiteralValuesIncluded: false,
        },
        verdict: { status: 'acceptable_evidence' },
      });
      expect(artifact.metrics.checkpointLoadMs.p95).toBeLessThanOrEqual(
        CHECKPOINT_TIMING_GATE_MS,
      );
      expect(artifact.metrics.checkpointWriteMs.p95).toBeLessThanOrEqual(
        CHECKPOINT_TIMING_GATE_MS,
      );
      expect(artifact.plans).toHaveLength(explainCases.length);
      for (const item of artifact.plans) {
        for (const indexName of item.expectedIndexes) {
          expect(item.observedIndexes).toContain(indexName);
        }
        expect(item.rowsScannedToReturnedRatio).toBeLessThanOrEqual(
          ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
        );
        expect(item.verdict).toBe('acceptable_evidence');
      }
    });

    it('fails resumed sessions before model startup when the checkpoint is missing', async () => {
      const store = new DeepAgentSessionStore({
        databaseUrl: databaseUrl ?? '',
        schema,
      });

      await expect(store.load('missing-session')).rejects.toThrow(
        MISSING_DEEPAGENTS_SESSION_MARKER,
      );
    });
  },
);

function tableRef(schemaName: string, tableName: string): string {
  return `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
}

function checkpointThreadId(index: number): string {
  return `checkpoint-thread-${index.toString().padStart(5, '0')}`;
}

function seedCheckpointId(index: number): string {
  return `seed-checkpoint-${index.toString().padStart(5, '0')}`;
}

function measuredCheckpointId(index: number): string {
  return `write-checkpoint-${index.toString().padStart(5, '0')}`;
}

function checkpointVersions(
  index: number,
  generation = 1,
): Record<string, number> {
  return { messages: index * 10 + generation };
}

function checkpointPayload(input: {
  index: number;
  checkpointId: string;
  largePayload?: boolean;
  generation?: number;
}): Parameters<DeepAgentCheckpointSaver['put']>[1] {
  const content = input.largePayload
    ? `large-payload-${input.index}:`.repeat(256)
    : `checkpoint-message-${input.index}`;
  return {
    v: 4,
    ts: new Date(input.index * 1000).toISOString(),
    id: input.checkpointId,
    channel_values: {
      messages: [{ role: 'human', content }],
    },
    channel_versions: checkpointVersions(input.index, input.generation ?? 1),
    versions_seen: {},
    pending_sends: [],
  };
}

function checkpointPayloadBytes(
  checkpoint: Parameters<DeepAgentCheckpointSaver['put']>[1],
): number {
  return Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');
}

async function seedCheckpointRowVolume(input: {
  databaseUrl: string;
  schema: string;
  threadCount: number;
}): Promise<void> {
  const seedPool = new pg.Pool({
    connectionString: input.databaseUrl,
    max: ROW_VOLUME_SEED_CONCURRENCY,
  });
  const saver = createDeepAgentCheckpointSaverFromPool(seedPool, input.schema);
  try {
    for (
      let start = 0;
      start < input.threadCount;
      start += ROW_VOLUME_SEED_CONCURRENCY
    ) {
      const end = Math.min(
        start + ROW_VOLUME_SEED_CONCURRENCY,
        input.threadCount,
      );
      await Promise.all(
        Array.from({ length: end - start }, async (_, offset) => {
          const index = start + offset;
          const sessionId = checkpointThreadId(index);
          const config = await saver.put(
            {
              configurable: {
                thread_id: sessionId,
                checkpoint_ns: CHECKPOINT_NS,
              },
            },
            checkpointPayload({
              index,
              checkpointId: seedCheckpointId(index),
              largePayload: index < 5,
            }),
            { source: 'row-volume-seed' },
            checkpointVersions(index),
          );
          await saver.putWrites(
            config,
            [['messages', { status: 'seeded', sample: index }]],
            `task-seed-${index}`,
          );
        }),
      );
    }
  } finally {
    await saver.end().catch(() => {});
  }
}

async function measureMs(work: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await work();
  return Math.max(0, Math.round(performance.now() - start));
}

function summarizeTiming(values: number[]): {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1),
  );
  return sortedValues[index] ?? 0;
}

async function loadCheckpointTableInventory(
  dbPool: pg.Pool,
  schemaName: string,
): Promise<{
  tables: Record<
    string,
    {
      cardinality: number;
      columns: string[];
    }
  >;
  indexes: Record<
    string,
    {
      tableName: string;
      definition: string;
    }
  >;
}> {
  const tables = await dbPool.query<{
    tablename: string;
    cardinality: string | number;
    columns: unknown;
  }>(
    `SELECT t.tablename,
            (xpath('/row/count/text()', query_to_xml(
              format('SELECT count(*) FROM %I.%I', schemaname, tablename),
              false,
              true,
              ''
            )))[1]::text::int AS cardinality,
            JSON_AGG(a.attname ORDER BY a.attnum) AS columns
       FROM pg_tables t
       JOIN pg_class c ON c.relname = t.tablename
       JOIN pg_namespace n
         ON n.oid = c.relnamespace
        AND n.nspname = t.schemaname
       JOIN pg_attribute a
         ON a.attrelid = c.oid
        AND a.attnum > 0
        AND NOT a.attisdropped
      WHERE t.schemaname = $1
        AND t.tablename IN (
          'checkpoint_migrations',
          'checkpoints',
          'checkpoint_blobs',
          'checkpoint_writes'
        )
      GROUP BY t.schemaname, t.tablename
      ORDER BY t.tablename`,
    [schemaName],
  );
  const indexes = await dbPool.query<{
    tablename: string;
    indexname: string;
    indexdef: string;
  }>(
    `SELECT tablename, indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = $1
        AND tablename IN (
          'checkpoint_migrations',
          'checkpoints',
          'checkpoint_blobs',
          'checkpoint_writes'
        )
      ORDER BY tablename, indexname`,
    [schemaName],
  );
  return {
    tables: Object.fromEntries(
      tables.rows.map((row) => [
        row.tablename,
        {
          cardinality: Number(row.cardinality),
          columns: Array.isArray(row.columns) ? row.columns : [],
        },
      ]),
    ),
    indexes: Object.fromEntries(
      indexes.rows.map((row) => [
        row.indexname,
        {
          tableName: row.tablename,
          definition: row.indexdef,
        },
      ]),
    ),
  };
}

function checkpointSelectSql(
  schemaName: string,
  input: { where: string },
): string {
  const checkpoints = tableRef(schemaName, 'checkpoints');
  const blobs = tableRef(schemaName, 'checkpoint_blobs');
  const writes = tableRef(schemaName, 'checkpoint_writes');
  return `SELECT
    thread_id,
    checkpoint,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    metadata,
    (
      SELECT array_agg(array[bl.channel::bytea, bl.type::bytea, bl.blob])
      FROM jsonb_each_text(checkpoint -> 'channel_versions')
      INNER JOIN ${blobs} bl
        ON bl.thread_id = cp.thread_id
        AND bl.checkpoint_ns = cp.checkpoint_ns
        AND bl.channel = jsonb_each_text.key
        AND bl.version = jsonb_each_text.value
    ) AS channel_values,
    (
      SELECT array_agg(array[cw.task_id::text::bytea, cw.channel::bytea, cw.type::bytea, cw.blob] ORDER BY cw.task_id, cw.idx)
      FROM ${writes} cw
      WHERE cw.thread_id = cp.thread_id
        AND cw.checkpoint_ns = cp.checkpoint_ns
        AND cw.checkpoint_id = cp.checkpoint_id
    ) AS pending_writes
  FROM ${checkpoints} cp
  ${input.where}`;
}
