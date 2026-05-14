import { randomUUID } from 'node:crypto';

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
