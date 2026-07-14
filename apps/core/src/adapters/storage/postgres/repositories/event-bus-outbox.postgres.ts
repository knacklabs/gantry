import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';

import type {
  EventBusEnvelope,
  EventBusPublisherPort,
  EventBusPublishInput,
} from '../../../../domain/events/event-bus.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import { nowIso } from '../../../../shared/time/datetime.js';

const CLAIMABLE_OUTBOX_STATUSES = ['pending', 'failed'];

export interface WebhookSubscriptionFilter {
  eventTypes: readonly string[] | null;
  agentId: string | null;
  sessionId: string | null;
  jobId: string | null;
}

export interface WebhookRuntimeEventSubject {
  eventType: string;
  agentId: string | null;
  sessionId: string | null;
  jobId: string | null;
}

export function webhookSubscriptionMatchesRuntimeEvent(
  subscription: WebhookSubscriptionFilter,
  event: WebhookRuntimeEventSubject,
): boolean {
  if (!subscription.eventTypes?.includes(event.eventType)) return false;
  return (
    (!subscription.agentId || subscription.agentId === event.agentId) &&
    (!subscription.sessionId || subscription.sessionId === event.sessionId) &&
    (!subscription.jobId || subscription.jobId === event.jobId)
  );
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class PostgresEventBusPublisher implements EventBusPublisherPort<CanonicalExecutor> {
  constructor(
    private readonly db: CanonicalDb,
    private readonly createId: () => string = randomUUID,
  ) {}

  async publish(
    input: EventBusPublishInput,
    executor: CanonicalExecutor = this.db,
  ): Promise<EventBusEnvelope> {
    const id = input.id ?? (this.createId() as EventBusEnvelope['id']);
    const now = nowIso();
    await executor
      .insert(pgSchema.eventBusOutboxPostgres)
      .values({
        id,
        eventType: input.type,
        eventVersion: input.version,
        source: input.source,
        appId: input.appId,
        runtimeEventId: input.runtimeEventId ?? null,
        correlationId: input.correlationId ?? null,
        payloadJson: encodeJson(input.payload),
        occurredAt: input.occurredAt,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        publishedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: pgSchema.eventBusOutboxPostgres.id,
      });
    return { ...input, id };
  }
}

export interface EventBusOutboxConsumeResult {
  claimed: number;
  deliveriesEnqueued: number;
  settled: number;
}

export async function settleEventBusOutboxRows(
  executor: CanonicalExecutor,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const settled = await executor
    .delete(pgSchema.eventBusOutboxPostgres)
    .where(inArray(pgSchema.eventBusOutboxPostgres.id, [...ids]))
    .returning({ id: pgSchema.eventBusOutboxPostgres.id });
  return settled.length;
}

export class PostgresEventBusOutboxConsumer {
  constructor(
    private readonly db: CanonicalDb,
    private readonly createId: () => string = randomUUID,
  ) {}

  async consume(limit = 50): Promise<EventBusOutboxConsumeResult> {
    return this.db.transaction(async (tx) => {
      const now = nowIso();
      const outboxRows = await tx
        .select()
        .from(pgSchema.eventBusOutboxPostgres)
        .where(
          and(
            inArray(
              pgSchema.eventBusOutboxPostgres.status,
              CLAIMABLE_OUTBOX_STATUSES,
            ),
            lte(pgSchema.eventBusOutboxPostgres.nextAttemptAt, now),
          ),
        )
        .orderBy(
          asc(pgSchema.eventBusOutboxPostgres.nextAttemptAt),
          asc(pgSchema.eventBusOutboxPostgres.createdAt),
        )
        .limit(Math.max(1, limit))
        .for('update', { skipLocked: true });
      if (outboxRows.length === 0) {
        return { claimed: 0, deliveriesEnqueued: 0, settled: 0 };
      }

      const runtimeEventIds = outboxRows.flatMap((row) =>
        row.runtimeEventId === null ? [] : [row.runtimeEventId],
      );
      const eventRows =
        runtimeEventIds.length === 0
          ? []
          : await tx
              .select({
                eventId: pgSchema.runtimeEventsPostgres.eventId,
                appId: pgSchema.runtimeEventsPostgres.appId,
                eventType: pgSchema.runtimeEventsPostgres.eventType,
                agentId: pgSchema.runtimeEventsPostgres.agentId,
                sessionId: pgSchema.runtimeEventsPostgres.sessionId,
                jobId: pgSchema.runtimeEventsPostgres.jobId,
              })
              .from(pgSchema.runtimeEventsPostgres)
              .where(
                inArray(
                  pgSchema.runtimeEventsPostgres.eventId,
                  runtimeEventIds,
                ),
              );
      const appIds = [...new Set(eventRows.map((event) => event.appId))];
      const subscriptions =
        appIds.length === 0
          ? []
          : await tx
              .select({
                webhookId: pgSchema.controlHttpWebhooksPostgres.webhookId,
                appId: pgSchema.controlHttpWebhooksPostgres.appId,
                eventTypes: pgSchema.controlHttpWebhooksPostgres.eventTypes,
                agentId: pgSchema.controlHttpWebhooksPostgres.agentId,
                sessionId: pgSchema.controlHttpWebhooksPostgres.sessionId,
                jobId: pgSchema.controlHttpWebhooksPostgres.jobId,
              })
              .from(pgSchema.controlHttpWebhooksPostgres)
              .where(
                and(
                  inArray(pgSchema.controlHttpWebhooksPostgres.appId, appIds),
                  eq(pgSchema.controlHttpWebhooksPostgres.enabled, true),
                  isNotNull(pgSchema.controlHttpWebhooksPostgres.eventTypes),
                ),
              );

      const deliveries = eventRows.flatMap((event) =>
        subscriptions
          .filter(
            (subscription) =>
              subscription.appId === event.appId &&
              webhookSubscriptionMatchesRuntimeEvent(subscription, event),
          )
          .map((subscription) => ({
            deliveryId: this.createId(),
            webhookId: subscription.webhookId,
            eventId: event.eventId,
            status: 'pending',
            attemptCount: 0,
            nextAttemptAt: now,
            createdAt: now,
            updatedAt: now,
          })),
      );
      const inserted =
        deliveries.length === 0
          ? []
          : await tx
              .insert(pgSchema.controlHttpWebhookDeliveriesPostgres)
              .values(deliveries)
              .onConflictDoNothing({
                target: [
                  pgSchema.controlHttpWebhookDeliveriesPostgres.webhookId,
                  pgSchema.controlHttpWebhookDeliveriesPostgres.eventId,
                ],
              })
              .returning({
                deliveryId:
                  pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
              });
      const settled = await settleEventBusOutboxRows(
        tx,
        outboxRows.map((row) => row.id),
      );
      return {
        claimed: outboxRows.length,
        deliveriesEnqueued: inserted.length,
        settled,
      };
    });
  }
}
