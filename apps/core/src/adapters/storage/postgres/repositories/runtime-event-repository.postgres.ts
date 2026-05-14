import { randomUUID } from 'node:crypto';

import { and, asc, eq, gt, inArray, type SQL } from 'drizzle-orm';

import type {
  EventBusPublisherPort,
  EventBusPublishInput,
} from '../../../../domain/events/event-bus.js';
import type {
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventPublishInput,
} from '../../../../domain/events/events.js';
import { requireRuntimeEventType } from '../../../../domain/events/runtime-event-types.js';
import type { RuntimeEventRepository } from '../../../../domain/ports/repositories.js';
import { logger } from '../../../../infrastructure/logging/logger.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import { PostgresEventBusPublisher } from './event-bus-outbox.postgres.js';

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

const RUNTIME_EVENT_BUS_SOURCE = 'myclaw.runtime_events';
const RUNTIME_EVENT_BUS_VERSION = 1;

export class PostgresRuntimeEventRepository implements RuntimeEventRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly eventBus: EventBusPublisherPort<CanonicalExecutor> = new PostgresEventBusPublisher(
      db,
    ),
  ) {}

  async appendRuntimeEvent(
    input: RuntimeEventPublishInput,
  ): Promise<RuntimeEvent> {
    return this.db.transaction(async (tx) => {
      const event = await this.insertRuntimeEvent(tx, input);
      await this.eventBus.publish(eventBusInputForRuntimeEvent(event), tx);
      await this.enqueueWebhookDeliveryIfNeeded(tx, event);
      return event;
    });
  }

  private async insertRuntimeEvent(
    db: CanonicalExecutor,
    input: RuntimeEventPublishInput,
  ): Promise<RuntimeEvent> {
    const rows = await db
      .insert(pgSchema.runtimeEventsPostgres)
      .values({
        appId: requiredId(input.appId, 'appId'),
        agentId: optionalId(input.agentId),
        sessionId: optionalId(input.sessionId),
        runId: optionalId(input.runId),
        jobId: optionalId(input.jobId),
        triggerId: optionalId(input.triggerId),
        conversationId: optionalId(input.conversationId),
        threadId: optionalId(input.threadId),
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
