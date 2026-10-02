import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { normalizeProviderId } from '../../../../channels/provider-registry.js';
import {
  type InboundEvent,
  type InboundEventRepository,
  type InboundSaveResult,
} from '../../../../domain/ports/inbound-events.js';
import { toIso } from '../../../../shared/time/datetime.js';
import { inboundEventsPostgres as events } from '../schema/inbound-events.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const identifier = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const inboundEventInputSchema = z.strictObject({
  appId: identifier,
  providerId: identifier.refine(
    (value) => value !== 'app' && normalizeProviderId(value) === value,
  ),
  connectionId: identifier,
  kind: z.enum(['message', 'slash']),
  eventKey: identifier,
  rawChannelId: identifier,
  rawThreadId: identifier.nullable(),
  rawMessageId: identifier.nullable(),
  payload: z.json(),
  control: z
    .strictObject({
      actorId: identifier,
      text: z.string(),
      entities: z.json().nullable(),
      routeSelector: identifier.nullable(),
    })
    .nullable(),
});

function fromRow(row: typeof events.$inferSelect): InboundEvent {
  return {
    ...row,
    receivedAt: toIso(row.receivedAt),
    claimExpiresAt: row.claimExpiresAt ? toIso(row.claimExpiresAt) : null,
    deadlineAt: row.deadlineAt ? toIso(row.deadlineAt) : null,
    nextAttemptAt: row.nextAttemptAt ? toIso(row.nextAttemptAt) : null,
    settledAt: row.settledAt ? toIso(row.settledAt) : null,
  };
}

export class PostgresInboundEventRepository implements InboundEventRepository {
  constructor(private readonly db: CanonicalDb) {}

  async save(input: unknown): Promise<InboundSaveResult> {
    if (
      typeof input === 'object' &&
      input !== null &&
      'outcome' in input &&
      input.outcome === 'unsupported'
    )
      return { outcome: 'unsupported' };
    const parsed = inboundEventInputSchema.safeParse(input);
    if (!parsed.success) return { outcome: 'malformed' };
    const event = parsed.data;
    return this.db.transaction(async (tx) => {
      // The bound connection FIFO preserves call order; this lock prevents a
      // later worker's save from allocating/committing past an uncommitted save.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['inbound-save', event.appId, event.providerId, event.connectionId])}, 0))`,
      );
      const identity = and(
        eq(events.appId, event.appId),
        eq(events.providerId, event.providerId),
        eq(events.connectionId, event.connectionId),
        eq(events.kind, event.kind),
        eq(events.eventKey, event.eventKey),
      );
      const [existing] = await tx
        .select()
        .from(events)
        .where(identity)
        .limit(1);
      if (existing) return { outcome: 'duplicate', event: fromRow(existing) };
      const [saved] = await tx
        .insert(events)
        .values({ id: randomUUID(), ...event })
        .returning();
      return { outcome: 'saved', event: fromRow(saved) };
    });
  }

  async get(id: string, appId: string): Promise<InboundEvent | null> {
    const [row] = await this.db
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.appId, appId)))
      .limit(1);
    return row ? fromRow(row) : null;
  }
}
