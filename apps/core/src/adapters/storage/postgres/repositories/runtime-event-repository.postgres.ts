import { randomUUID } from 'node:crypto';

import { and, asc, eq, gt, inArray, type SQL } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';

import type {
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventPublishInput,
} from '../../../../domain/events/events.js';
import type { RuntimeEventRepository } from '../../../../domain/ports/repositories.js';
import { logger } from '../../../../infrastructure/logging/logger.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

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
  return new Date().toISOString();
}

const RUNTIME_EVENT_RETURNING_SQL = `
  event_id AS "eventId",
  app_id AS "appId",
  agent_id AS "agentId",
  session_id AS "sessionId",
  run_id AS "runId",
  job_id AS "jobId",
  trigger_id AS "triggerId",
  conversation_id AS "conversationId",
  thread_id AS "threadId",
  event_type AS "eventType",
  actor,
  correlation_id AS "correlationId",
  response_mode AS "responseMode",
  webhook_id AS "webhookId",
  payload_json AS "payloadJson",
  created_at AS "createdAt"
`;

export class PostgresRuntimeEventRepository implements RuntimeEventRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly pool?: Pool,
  ) {}

  async appendRuntimeEvent(
    input: RuntimeEventPublishInput,
  ): Promise<RuntimeEvent> {
    if (this.pool) {
      return this.appendRuntimeEventAtomically(input);
    }

    const rows = await this.db
      .insert(pgSchema.runtimeEventsPostgres)
      .values({
        appId: input.appId,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        jobId: input.jobId ?? null,
        triggerId: input.triggerId ?? null,
        conversationId: input.conversationId ?? null,
        threadId: input.threadId ?? null,
        eventType: input.eventType,
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

  private async appendRuntimeEventAtomically(
    input: RuntimeEventPublishInput,
  ): Promise<RuntimeEvent> {
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      const event = await this.insertRuntimeEvent(client, input);
      await this.enqueueWebhookDeliveryIfNeeded(client, event);
      await client.query('COMMIT');
      return event;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.warn(
          { err: rollbackErr },
          'Failed to roll back runtime event append transaction',
        );
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertRuntimeEvent(
    client: PoolClient,
    input: RuntimeEventPublishInput,
  ): Promise<RuntimeEvent> {
    const rows = await client.query<RuntimeEventRow>(
      `INSERT INTO runtime_events
         (app_id, agent_id, session_id, run_id, job_id, trigger_id,
          conversation_id, thread_id, event_type, actor, correlation_id,
          response_mode, webhook_id, payload_json, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${RUNTIME_EVENT_RETURNING_SQL}`,
      [
        input.appId,
        input.agentId ?? null,
        input.sessionId ?? null,
        input.runId ?? null,
        input.jobId ?? null,
        input.triggerId ?? null,
        input.conversationId ?? null,
        input.threadId ?? null,
        input.eventType,
        input.actor,
        input.correlationId ?? null,
        input.responseMode ?? null,
        input.webhookId ?? null,
        encodeJson(input.payload),
        input.createdAt ?? currentIso(),
      ],
    );
    return this.eventFromRow(rows.rows[0]!);
  }

  private async enqueueWebhookDeliveryIfNeeded(
    client: PoolClient,
    event: RuntimeEvent,
  ): Promise<void> {
    if (
      !event.webhookId ||
      (event.responseMode !== 'webhook' && event.responseMode !== 'both')
    ) {
      return;
    }

    const webhook = await client.query<{ webhook_id: string }>(
      `SELECT webhook_id
       FROM control_http_webhooks
       WHERE webhook_id = $1 AND app_id = $2
       LIMIT 1`,
      [event.webhookId, event.appId],
    );
    if (!webhook.rows[0]) return;

    await client.query(
      `INSERT INTO control_http_webhook_deliveries
         (delivery_id, webhook_id, event_id, status, attempt_count,
          next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', 0, $4, $4, $4)
       ON CONFLICT (webhook_id, event_id) DO NOTHING`,
      [randomUUID(), event.webhookId, event.eventId, currentIso()],
    );
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

  private eventFromRow(row: RuntimeEventRow): RuntimeEvent {
    const rawCreatedAt = row.createdAt as unknown;
    const createdAt =
      rawCreatedAt instanceof Date
        ? rawCreatedAt.toISOString()
        : String(rawCreatedAt);
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
      eventType: row.eventType as RuntimeEvent['eventType'],
      actor: row.actor,
      correlationId: row.correlationId ?? undefined,
      responseMode: row.responseMode as RuntimeEvent['responseMode'],
      webhookId: row.webhookId ?? undefined,
      payload: parseJson(row.payloadJson, null, { eventId: row.eventId }),
      createdAt,
    };
  }
}
