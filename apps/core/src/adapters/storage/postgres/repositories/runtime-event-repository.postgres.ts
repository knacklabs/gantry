import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm';

import type {
  EventBusPublisherPort,
  EventBusPublishInput,
} from '../../../../domain/events/event-bus.js';
import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import type {
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventPublishInput,
  ConsoleMetricUsage,
  ConsoleMetricsProjection,
  ConsoleMetricsQuery,
  UsageAggregate,
  UsageQuery,
} from '../../../../domain/events/events.js';
import type { LiveAdmissionWorkItemEnqueueResult } from '../../../../domain/ports/live-turns.js';
import {
  requireRuntimeEventType,
  RUNTIME_EVENT_TYPES,
} from '../../../../domain/events/runtime-event-types.js';
import type { RuntimeEventRepository } from '../../../../domain/ports/repositories.js';
import { logger } from '../../../../infrastructure/logging/logger.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import {
  canonicalProviderThreadForIds,
  type CanonicalDb,
  type CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import { PostgresEventBusPublisher } from './event-bus-outbox.postgres.js';
import {
  type MessageLiveAdmissionInput,
  PostgresCanonicalMessageRepository,
} from './canonical-message-repository.postgres.js';
import type { ProviderAttachmentCleanup } from './provider-attachment-cleanup.postgres.js';

type RuntimeEventRow = typeof pgSchema.runtimeEventsPostgres.$inferSelect;

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(
  value: unknown,
  fallback: T,
  context?: { eventId?: number },
): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    logger.warn(
      {
        err,
        eventId: context?.eventId,
        payloadPreview: value.slice(0, 200),
      },
      'Failed to parse runtime event payload JSON',
    );
    return fallback;
  }
}

function currentIso(): string {
  return nowIso();
}

function normalizeTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value);
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return raw;
}

function requiredId(value: unknown, name: string): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new Error(`Runtime event ${name} is required.`);
  return id;
}

function optionalId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return id || null;
}

const RUNTIME_EVENT_BUS_SOURCE = 'gantry.runtime_events';
const RUNTIME_EVENT_BUS_VERSION = 1;
const RUNTIME_EVENT_RETENTION_BATCH_SIZE = 500;

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

export class PostgresRuntimeEventRepository implements RuntimeEventRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly eventBus: EventBusPublisherPort<CanonicalExecutor> = new PostgresEventBusPublisher(
      db,
    ),
    private readonly maxLiveAdmissionBacklog = 100,
    private readonly cleanupProviderAttachment?: ProviderAttachmentCleanup,
  ) {}

  async appendRuntimeEvent(
    input: RuntimeEventPublishInput,
  ): Promise<RuntimeEvent> {
    return this.db.transaction((tx) =>
      this.appendRuntimeEventWithExecutor(tx, input),
    );
  }

  async appendRuntimeEventWithExecutor(
    executor: CanonicalExecutor,
    input: RuntimeEventPublishInput,
  ): Promise<RuntimeEvent> {
    const event = await this.insertRuntimeEvent(executor, input);
    await this.eventBus.publish(eventBusInputForRuntimeEvent(event), executor);
    await this.enqueueWebhookDeliveryIfNeeded(executor, event);
    return event;
  }

  async appendRuntimeEventAndStoreLiveAdmission(
    input: RuntimeEventPublishInput,
    admission: {
      message: NewMessage;
      liveAdmission: MessageLiveAdmissionInput;
    },
  ): Promise<{
    event: RuntimeEvent;
    liveAdmissionResult: LiveAdmissionWorkItemEnqueueResult | undefined;
  }> {
    const messages = new PostgresCanonicalMessageRepository(
      this.db,
      this.maxLiveAdmissionBacklog,
      this.cleanupProviderAttachment,
    );
    const result = await this.db.transaction(async (tx) => {
      const messageSaveResult = await messages.saveMessageWithExecutor(
        tx,
        admission.message,
        { liveAdmission: admission.liveAdmission },
      );
      const event = await this.insertRuntimeEvent(tx, input);
      await this.eventBus.publish(eventBusInputForRuntimeEvent(event), tx);
      await this.enqueueWebhookDeliveryIfNeeded(tx, event);
      return { event, messageSaveResult };
    });
    await messages.cleanupRemovedProviderAttachments(
      result.messageSaveResult.removedProviderStorageRefs,
    );
    return {
      event: result.event,
      liveAdmissionResult: result.messageSaveResult.liveAdmissionResult,
    };
  }

  private async insertRuntimeEvent(
    db: CanonicalExecutor,
    input: RuntimeEventPublishInput,
  ): Promise<RuntimeEvent> {
    const appId = requiredId(input.appId, 'appId');
    const conversationId = optionalId(input.conversationId);
    const threadId = optionalId(input.threadId);
    const providerThread = canonicalProviderThreadForIds({
      appId,
      conversationId,
      threadId,
    });
    if (providerThread) {
      await db
        .insert(pgSchema.conversationThreadsPostgres)
        .values({
          id: providerThread.id,
          appId: providerThread.appId,
          conversationId: providerThread.conversationId,
          externalRefJson: providerThread.externalRefJson,
          updatedAt: currentIso(),
        })
        .onConflictDoNothing();
    }

    const rows = await db
      .insert(pgSchema.runtimeEventsPostgres)
      .values({
        appId,
        agentId: optionalId(input.agentId),
        sessionId: optionalId(input.sessionId),
        runId: optionalId(input.runId),
        jobId: optionalId(input.jobId),
        triggerId: optionalId(input.triggerId),
        conversationId,
        threadId,
        eventType: requireRuntimeEventType(input.eventType),
        actor: input.actor,
        correlationId: input.correlationId ?? null,
        responseMode: input.responseMode ?? null,
        webhookId: input.webhookId ?? null,
        payloadJson: encodeJson(input.payload),
        createdAt: input.createdAt ?? currentIso(),
      })
      .returning();
    return this.eventFromRow(rows[0]!);
  }

  private async enqueueWebhookDeliveryIfNeeded(
    db: CanonicalExecutor,
    event: RuntimeEvent,
  ): Promise<void> {
    if (
      !event.webhookId ||
      (event.responseMode !== 'webhook' && event.responseMode !== 'both')
    ) {
      return;
    }

    const webhook = await db
      .select({ webhookId: pgSchema.controlHttpWebhooksPostgres.webhookId })
      .from(pgSchema.controlHttpWebhooksPostgres)
      .where(
        and(
          eq(pgSchema.controlHttpWebhooksPostgres.webhookId, event.webhookId),
          eq(pgSchema.controlHttpWebhooksPostgres.appId, event.appId),
        ),
      )
      .limit(1);
    if (!webhook[0]) return;

    const now = currentIso();
    await db
      .insert(pgSchema.controlHttpWebhookDeliveriesPostgres)
      .values({
        deliveryId: randomUUID(),
        webhookId: event.webhookId,
        eventId: event.eventId,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          pgSchema.controlHttpWebhookDeliveriesPostgres.webhookId,
          pgSchema.controlHttpWebhookDeliveriesPostgres.eventId,
        ],
      });
  }

  async listRuntimeEvents(filter: RuntimeEventFilter): Promise<RuntimeEvent[]> {
    const conditions: SQL[] = [
      eq(pgSchema.runtimeEventsPostgres.appId, filter.appId),
    ];
    if (filter.afterEventId !== undefined) {
      conditions.push(
        gt(pgSchema.runtimeEventsPostgres.eventId, filter.afterEventId),
      );
    }
    if (filter.sessionId !== undefined) {
      conditions.push(
        eq(pgSchema.runtimeEventsPostgres.sessionId, filter.sessionId),
      );
    }
    if (filter.runId !== undefined) {
      conditions.push(eq(pgSchema.runtimeEventsPostgres.runId, filter.runId));
    }
    if (filter.jobId !== undefined) {
      conditions.push(eq(pgSchema.runtimeEventsPostgres.jobId, filter.jobId));
    }
    if (filter.triggerId !== undefined) {
      conditions.push(
        eq(pgSchema.runtimeEventsPostgres.triggerId, filter.triggerId),
      );
    }
    if (filter.conversationId !== undefined) {
      conditions.push(
        eq(
          pgSchema.runtimeEventsPostgres.conversationId,
          filter.conversationId,
        ),
      );
    }
    if (filter.conversationIds?.length) {
      conditions.push(
        inArray(
          pgSchema.runtimeEventsPostgres.conversationId,
          filter.conversationIds,
        ),
      );
    }
    if (filter.threadId !== undefined) {
      conditions.push(
        eq(pgSchema.runtimeEventsPostgres.threadId, filter.threadId),
      );
    }
    if (filter.eventTypes?.length) {
      conditions.push(
        inArray(pgSchema.runtimeEventsPostgres.eventType, filter.eventTypes),
      );
    }

    const rows = await this.db
      .select()
      .from(pgSchema.runtimeEventsPostgres)
      .where(and(...conditions))
      .orderBy(asc(pgSchema.runtimeEventsPostgres.eventId))
      .limit(filter.limit ?? 100);
    return rows.map((row) => this.eventFromRow(row));
  }

  async queryUsage(input: UsageQuery): Promise<UsageAggregate[]> {
    const events = pgSchema.runtimeEventsPostgres;
    const payload = sql`${events.payloadJson}::jsonb`;
    const usage = sql`${payload}->'usage'`;
    const model = sql<string | null>`coalesce(
      ${usage}->>'model',
      ${payload}->>'modelAlias',
      ${payload}->>'resolved_model_alias'
    )`;
    const apiKeyId = sql<string | null>`${payload}->>'apiKeyId'`;
    const day = sql<string>`to_char(
      date_trunc('day', ${events.createdAt} at time zone 'UTC'),
      'YYYY-MM-DD'
    )`;
    const groupExpression =
      input.groupBy === 'agent'
        ? sql<string | null>`${events.agentId}`
        : input.groupBy === 'api_key'
          ? apiKeyId
          : input.groupBy === 'model'
            ? model
            : input.groupBy === 'day'
              ? day
              : undefined;
    const conditions: SQL[] = [
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
          AND ${apiKeyId} IS NOT NULL
          AND ${payload}->>'tokenScope' LIKE 'api_key:%'
        )
      )`,
    ];
    if (input.agentId) conditions.push(eq(events.agentId, input.agentId));
    if (input.apiKeyId) conditions.push(sql`${apiKeyId} = ${input.apiKeyId}`);
    if (input.runId) conditions.push(eq(events.runId, input.runId));
    if (input.jobId) conditions.push(eq(events.jobId, input.jobId));
    if (input.model) conditions.push(sql`${model} = ${input.model}`);

    const query = this.db
      .select({
        groupKey: groupExpression ?? sql<null>`null`,
        requestCount: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum((${usage}->>'inputTokens')::bigint), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum((${usage}->>'outputTokens')::bigint), 0)::bigint`,
      })
      .from(events)
      .where(and(...conditions))
      .$dynamic();
    const rows = groupExpression
      ? await query.groupBy(groupExpression).orderBy(asc(groupExpression))
      : await query;

    return rows.map((row) => ({
      requestCount: Number(row.requestCount),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      ...(input.groupBy === 'agent' && row.groupKey
        ? { agentId: String(row.groupKey) }
        : {}),
      ...(input.groupBy === 'api_key' && row.groupKey
        ? { apiKeyId: String(row.groupKey) }
        : {}),
      ...(input.groupBy === 'model' && row.groupKey
        ? { model: String(row.groupKey) }
        : {}),
      ...(input.groupBy === 'day' && row.groupKey
        ? { day: String(row.groupKey) }
        : {}),
    }));
  }

  async queryConsoleMetrics(
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
        this.db
          .select(fields)
          .from(events)
          .where(and(...usageConditions)),
        this.db
          .select({ start: bucketStart, ...fields })
          .from(events)
          .where(and(...usageConditions))
          .groupBy(bucketStart)
          .orderBy(asc(bucketStart)),
        this.db
          .select({ model, ...fields })
          .from(events)
          .where(and(...usageConditions))
          .groupBy(model)
          .orderBy(desc(fields.requestCount), asc(model))
          .limit(5),
        this.db
          .select({
            total: sql<number>`count(*)::int`,
            p95DurationMs: sql<
              number | null
            >`percentile_cont(0.95) within group (
              order by extract(epoch from (${pgSchema.agentRunsPostgres.endedAt} - ${pgSchema.agentRunsPostgres.startedAt})) * 1000
            )`,
          })
          .from(pgSchema.agentRunsPostgres)
          .where(
            and(
              eq(pgSchema.agentRunsPostgres.appId, input.appId),
              inArray(pgSchema.agentRunsPostgres.status, [
                'completed',
                'failed',
                'canceled',
              ]),
              gte(pgSchema.agentRunsPostgres.endedAt, input.from),
              lt(pgSchema.agentRunsPostgres.endedAt, input.to),
              sql`${pgSchema.agentRunsPostgres.startedAt} is not null`,
            ),
          ),
        this.db
          .select({
            status: pgSchema.agentRunsPostgres.status,
            count: sql<number>`count(*)::int`,
          })
          .from(pgSchema.agentRunsPostgres)
          .where(
            and(
              eq(pgSchema.agentRunsPostgres.appId, input.appId),
              inArray(pgSchema.agentRunsPostgres.status, [
                'completed',
                'failed',
                'canceled',
              ]),
              gte(pgSchema.agentRunsPostgres.endedAt, input.from),
              lt(pgSchema.agentRunsPostgres.endedAt, input.to),
              sql`${pgSchema.agentRunsPostgres.startedAt} is not null`,
            ),
          )
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
        modelRows.reduce(
          (sum, row) => sum + Number(row.cacheWriteTokenCount),
          0,
        )
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

  async deleteExpiredRuntimeEvents(
    cutoffIso: string,
  ): Promise<{ deleted: number; more: boolean }> {
    return this.db.transaction(async (tx) => {
      const lock = await tx.execute<{ acquired: boolean }>(sql`
        select pg_try_advisory_xact_lock(
          hashtext('gantry.runtime_event_retention')
        ) as acquired
      `);
      if (!lock.rows[0]?.acquired) return { deleted: 0, more: true };

      const events = pgSchema.runtimeEventsPostgres;
      const candidates = await tx
        .select({ eventId: events.eventId })
        .from(events)
        .where(
          and(
            lt(events.createdAt, cutoffIso),
            sql`not exists (
              select 1 from ${pgSchema.eventBusOutboxPostgres} outbox
              where outbox.runtime_event_id = ${events.eventId}
                and outbox.status in ('pending', 'failed', 'in_progress')
            )`,
            sql`not exists (
              select 1 from ${pgSchema.controlHttpWebhookDeliveriesPostgres} delivery
              where delivery.event_id = ${events.eventId}
                and delivery.status in ('pending', 'retrying', 'delivering', 'in_progress')
            )`,
          ),
        )
        .orderBy(asc(events.createdAt), asc(events.eventId))
        .limit(RUNTIME_EVENT_RETENTION_BATCH_SIZE)
        .for('update', { skipLocked: true });
      if (candidates.length === 0) return { deleted: 0, more: false };
      const deleted = await tx
        .delete(events)
        .where(
          inArray(
            events.eventId,
            candidates.map((candidate) => candidate.eventId),
          ),
        )
        .returning({ eventId: events.eventId });
      return {
        deleted: deleted.length,
        more: candidates.length === RUNTIME_EVENT_RETENTION_BATCH_SIZE,
      };
    });
  }

  private eventFromRow(row: RuntimeEventRow): RuntimeEvent {
    return {
      eventId: row.eventId as RuntimeEvent['eventId'],
      appId: row.appId as RuntimeEvent['appId'],
      agentId: row.agentId
        ? (row.agentId as RuntimeEvent['agentId'])
        : undefined,
      sessionId: row.sessionId
        ? (row.sessionId as RuntimeEvent['sessionId'])
        : undefined,
      runId: row.runId ? (row.runId as RuntimeEvent['runId']) : undefined,
      jobId: row.jobId ? (row.jobId as RuntimeEvent['jobId']) : undefined,
      triggerId: row.triggerId ?? undefined,
      conversationId: row.conversationId
        ? (row.conversationId as RuntimeEvent['conversationId'])
        : undefined,
      threadId: row.threadId
        ? (row.threadId as RuntimeEvent['threadId'])
        : undefined,
      eventType: requireRuntimeEventType(row.eventType),
      actor: row.actor,
      correlationId: row.correlationId ?? undefined,
      responseMode: row.responseMode as RuntimeEvent['responseMode'],
      webhookId: row.webhookId ?? undefined,
      payload: parseJson(row.payloadJson, null, { eventId: row.eventId }),
      createdAt: normalizeTimestamp(row.createdAt),
    };
  }
}

function eventBusInputForRuntimeEvent(
  event: RuntimeEvent,
): EventBusPublishInput {
  return {
    type: event.eventType,
    version: RUNTIME_EVENT_BUS_VERSION,
    source: RUNTIME_EVENT_BUS_SOURCE,
    appId: event.appId,
    runtimeEventId: event.eventId,
    correlationId: event.correlationId ?? null,
    occurredAt: event.createdAt,
    payload: {
      runtimeEvent: event,
    },
  };
}
