import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm';

import type {
  ConsoleMetricUsage,
  ConsoleMetricsProjection,
  ConsoleMetricsQuery,
} from '../../../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

function metricUsage(row: {
  requestCount: unknown;
  inputTokens: unknown;
  outputTokens: unknown;
  cacheReadTokens: unknown;
  cacheWriteTokens: unknown;
  estimatedCostUsd: unknown;
}): ConsoleMetricUsage {
  return {
    requestCount: Number(row.requestCount),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    ...(row.cacheReadTokens === null
      ? {}
      : { cacheReadTokens: Number(row.cacheReadTokens) }),
    ...(row.cacheWriteTokens === null
      ? {}
      : { cacheWriteTokens: Number(row.cacheWriteTokens) }),
    ...(row.estimatedCostUsd === null
      ? {}
      : { estimatedCostUsd: Number(row.estimatedCostUsd) }),
  };
}

export async function queryConsoleMetrics(
  db: CanonicalDb,
  input: ConsoleMetricsQuery,
): Promise<ConsoleMetricsProjection> {
  const events = pgSchema.runtimeEventsPostgres;
  const payload = sql`${events.payloadJson}::jsonb`;
  const usage = sql`${payload}->'usage'`;
  const model = sql<string>`coalesce(
    ${usage}->>'model',
    ${payload}->>'modelAlias',
    ${payload}->>'resolved_model_alias',
    'Unknown'
  )`;
  const usageConditions: SQL[] = [
    eq(events.appId, input.appId),
    gte(events.createdAt, input.from),
    lt(events.createdAt, input.to),
    sql`jsonb_typeof(${usage}->'inputTokens') = 'number'`,
    sql`jsonb_typeof(${usage}->'outputTokens') = 'number'`,
    sql`(
      ${events.eventType} = ${RUNTIME_EVENT_TYPES.MODEL_USAGE}
      OR ${events.eventType} IN (
        ${RUNTIME_EVENT_TYPES.JOB_COMPLETED},
        ${RUNTIME_EVENT_TYPES.JOB_FAILED}
      )
      OR (
        ${events.eventType} = ${RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_USED}
        AND ${payload}->>'outcome' = 'forwarded'
        AND ${payload}->>'apiKeyId' IS NOT NULL
        AND ${payload}->>'tokenScope' LIKE 'api_key:%'
      )
    )`,
  ];
  const fields = {
    requestCount: sql<number>`count(*)::int`,
    inputTokens: sql<number>`coalesce(sum((${usage}->>'inputTokens')::bigint), 0)::bigint`,
    outputTokens: sql<number>`coalesce(sum((${usage}->>'outputTokens')::bigint), 0)::bigint`,
    cacheReadTokens: sql<
      number | null
    >`sum((${usage}->>'cacheReadTokens')::bigint) filter (where jsonb_typeof(${usage}->'cacheReadTokens') = 'number')::bigint`,
    cacheReadTokenCount: sql<number>`count(*) filter (where jsonb_typeof(${usage}->'cacheReadTokens') = 'number')::int`,
    cacheWriteTokens: sql<
      number | null
    >`sum((${usage}->>'cacheWriteTokens')::bigint) filter (where jsonb_typeof(${usage}->'cacheWriteTokens') = 'number')::bigint`,
    cacheWriteTokenCount: sql<number>`count(*) filter (where jsonb_typeof(${usage}->'cacheWriteTokens') = 'number')::int`,
    estimatedCostUsd: sql<
      number | null
    >`sum((${usage}->>'estimatedCostUsd')::double precision) filter (where jsonb_typeof(${usage}->'estimatedCostUsd') = 'number')`,
    estimatedCostCount: sql<number>`count(*) filter (where jsonb_typeof(${usage}->'estimatedCostUsd') = 'number')::int`,
  };
  const bucketStart =
    input.bucket === 'hour'
      ? sql<string>`to_char(
          date_trunc('hour', ${events.createdAt} at time zone 'UTC'),
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        )`
      : sql<string>`to_char(
          date_trunc('day', ${events.createdAt} at time zone 'UTC'),
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        )`;

  const [totalRows, bucketRows, modelRows, runRows, statusRows] =
    await Promise.all([
      db
        .select(fields)
        .from(events)
        .where(and(...usageConditions)),
      db
        .select({ start: bucketStart, ...fields })
        .from(events)
        .where(and(...usageConditions))
        .groupBy(bucketStart)
        .orderBy(asc(bucketStart)),
      db
        .select({ model, ...fields })
        .from(events)
        .where(and(...usageConditions))
        .groupBy(model)
        .orderBy(desc(fields.requestCount), asc(model))
        .limit(5),
      db
        .select({
          total: sql<number>`count(*)::int`,
          p95DurationMs: sql<number | null>`percentile_cont(0.95) within group (
            order by extract(epoch from (${pgSchema.agentRunsPostgres.endedAt} - ${pgSchema.agentRunsPostgres.startedAt})) * 1000
          )`,
        })
        .from(pgSchema.agentRunsPostgres)
        .where(runConditions(input)),
      db
        .select({
          status: pgSchema.agentRunsPostgres.status,
          count: sql<number>`count(*)::int`,
        })
        .from(pgSchema.agentRunsPostgres)
        .where(runConditions(input))
        .groupBy(pgSchema.agentRunsPostgres.status)
        .orderBy(asc(pgSchema.agentRunsPostgres.status)),
    ]);

  const totals = metricUsage(totalRows[0]!);
  const topModels = modelRows.map((row) => ({
    model: row.model,
    ...metricUsage(row),
  }));
  const namedRequestCount = topModels.reduce(
    (sum, row) => sum + row.requestCount,
    0,
  );
  if (namedRequestCount < totals.requestCount) {
    topModels.push({
      model: 'Other',
      requestCount: totals.requestCount - namedRequestCount,
      inputTokens:
        totals.inputTokens -
        topModels.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens:
        totals.outputTokens -
        topModels.reduce((sum, row) => sum + row.outputTokens, 0),
      ...(Number(totalRows[0]!.cacheReadTokenCount) >
      modelRows.reduce((sum, row) => sum + Number(row.cacheReadTokenCount), 0)
        ? {
            cacheReadTokens:
              (totals.cacheReadTokens ?? 0) -
              topModels.reduce(
                (sum, row) => sum + (row.cacheReadTokens ?? 0),
                0,
              ),
          }
        : {}),
      ...(Number(totalRows[0]!.cacheWriteTokenCount) >
      modelRows.reduce((sum, row) => sum + Number(row.cacheWriteTokenCount), 0)
        ? {
            cacheWriteTokens:
              (totals.cacheWriteTokens ?? 0) -
              topModels.reduce(
                (sum, row) => sum + (row.cacheWriteTokens ?? 0),
                0,
              ),
          }
        : {}),
      ...(Number(totalRows[0]!.estimatedCostCount) >
      modelRows.reduce((sum, row) => sum + Number(row.estimatedCostCount), 0)
        ? {
            estimatedCostUsd:
              (totals.estimatedCostUsd ?? 0) -
              topModels.reduce(
                (sum, row) => sum + (row.estimatedCostUsd ?? 0),
                0,
              ),
          }
        : {}),
    });
  }
  const run = runRows[0]!;
  return {
    usage: {
      totals,
      buckets: bucketRows.map((row) => ({
        start:
          row.start as ConsoleMetricsProjection['usage']['buckets'][number]['start'],
        ...metricUsage(row),
      })),
      models: topModels,
    },
    runs: {
      total: Number(run.total),
      statuses: statusRows.map((row) => ({
        status:
          row.status as ConsoleMetricsProjection['runs']['statuses'][number]['status'],
        count: Number(row.count),
      })),
      ...(run.p95DurationMs === null
        ? {}
        : { p95DurationMs: Number(run.p95DurationMs) }),
    },
  };
}

function runConditions(input: ConsoleMetricsQuery): SQL {
  return and(
    eq(pgSchema.agentRunsPostgres.appId, input.appId),
    inArray(pgSchema.agentRunsPostgres.status, [
      'completed',
      'failed',
      'canceled',
    ]),
    gte(pgSchema.agentRunsPostgres.endedAt, input.from),
    lt(pgSchema.agentRunsPostgres.endedAt, input.to),
    sql`${pgSchema.agentRunsPostgres.startedAt} is not null`,
  )!;
}
