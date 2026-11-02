import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { normalizeProviderId } from '../../../../channels/provider-registry.js';
import {
  type InboundEvent,
  type StagedInboundEventRepository,
  type InboundSaveResult,
  type InboundClaimInput,
  type InboundClaimGuard,
  type InboundClaimedEvent,
  type InboundWriteResult,
  INBOUND_EVENT_BUDGET_MS,
  INBOUND_EVENT_CLAIM_MS,
} from '../../../../domain/ports/inbound-events.js';
import { toIso } from '../../../../shared/time/datetime.js';
import { inboundEventsPostgres as events } from '../schema/inbound-events.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const identifier = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const ordinaryEventInputSchema = z.strictObject({
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
const inboundEventInputSchema = z.discriminatedUnion('kind', [
  ordinaryEventInputSchema,
  ordinaryEventInputSchema.extend({
    kind: z.literal('malformed'),
    rawChannelId: z.union([identifier, z.literal('')]),
    control: z.null(),
    reason: z.enum(['missing_identity', 'invalid_scope', 'invalid_message']),
  }),
]);

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

export class PostgresInboundEventRepository implements StagedInboundEventRepository {
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
    if (!parsed.success) return { outcome: 'invalid' };
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
        .values({
          id: randomUUID(),
          ...event,
          failedOperation: event.kind === 'malformed' ? event.reason : null,
        })
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

  async claimHeads({
    scope,
    limit,
  }: InboundClaimInput): Promise<InboundClaimedEvent[]> {
    return this.db.transaction(async (tx) => {
      // Serialize selection within this authenticated connection, including reclaim.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['inbound-claim', scope])}, 0))`,
      );
      const scoped = and(
        eq(events.appId, scope.appId),
        eq(events.providerId, scope.providerId),
        eq(events.connectionId, scope.connectionId),
      );
      await tx
        .update(events)
        .set({
          state: 'set_aside',
          claimToken: null,
          claimExpiresAt: null,
          failedOperation: 'attempts_exhausted',
        })
        .where(
          and(
            scoped,
            sql`${events.state} IN ('pending', 'claimed')`,
            sql`${events.attempts} >= 6`,
            sql`(${events.claimExpiresAt} IS NULL OR ${events.claimExpiresAt} <= clock_timestamp())`,
          ),
        );
      const heads = await tx
        .select()
        .from(events)
        .where(
          and(
            scoped,
            sql`${events.state} IN ('pending', 'claimed')`,
            sql`(${events.claimExpiresAt} IS NULL OR ${events.claimExpiresAt} <= clock_timestamp())`,
            sql`(${events.nextAttemptAt} IS NULL OR ${events.nextAttemptAt} <= clock_timestamp())`,
            sql`NOT EXISTS (SELECT 1 FROM inbound_events previous WHERE previous.app_id = ${events.appId} AND previous.provider_id = ${events.providerId} AND previous.connection_id = ${events.connectionId} AND previous.raw_channel_id = ${events.rawChannelId} AND previous.raw_thread_id IS NOT DISTINCT FROM ${events.rawThreadId} AND previous.state IN ('pending', 'claimed') AND previous.seq < ${events.seq})`,
          ),
        )
        .orderBy(events.seq)
        .limit(Math.max(0, Math.min(4, limit)))
        .for('update', { skipLocked: true });
      const claimed: InboundClaimedEvent[] = [];
      for (const head of heads) {
        const [row] = await tx
          .update(events)
          .set({
            state: 'claimed',
            claimToken: randomUUID(),
            attempts: head.attempts + 1,
            claimExpiresAt: sql`clock_timestamp() + ${INBOUND_EVENT_CLAIM_MS} * interval '1 millisecond'`,
            // A restart after the old budget expired can still recover saved work.
            // The public guard crosses JS Date's millisecond boundary. Keep the
            // stored deadline exact at that precision so fencing compares equal.
            deadlineAt: sql`CASE WHEN ${events.deadlineAt} > clock_timestamp() THEN ${events.deadlineAt} ELSE date_trunc('milliseconds', clock_timestamp()) + ${INBOUND_EVENT_BUDGET_MS} * interval '1 millisecond' END`,
            nextAttemptAt: null,
          })
          .where(eq(events.id, head.id))
          .returning();
        claimed.push(fromRow(row) as InboundClaimedEvent);
      }
      return claimed;
    });
  }

  private guard(input: InboundClaimGuard, requireLive = true) {
    return and(
      eq(events.appId, input.appId),
      eq(events.id, input.eventId),
      eq(events.state, 'claimed'),
      eq(events.claimToken, input.claimToken),
      eq(events.deadlineAt, input.deadlineAt),
      requireLive
        ? sql`${events.deadlineAt} > clock_timestamp() AND ${events.claimExpiresAt} > clock_timestamp()`
        : undefined,
    );
  }

  async release(input: InboundClaimGuard): Promise<InboundWriteResult> {
    const rows = await this.db
      .update(events)
      .set({ state: 'pending', claimToken: null, claimExpiresAt: null })
      .where(this.guard(input, false))
      .returning({ id: events.id });
    return { outcome: rows.length ? 'applied' : 'stale_claim' };
  }

  async settle(input: InboundClaimGuard): Promise<InboundWriteResult> {
    const rows = await this.db
      .update(events)
      .set({
        state: 'completed',
        payload: null,
        control: null,
        unpacked: null,
        claimToken: null,
        claimExpiresAt: null,
        settledAt: sql`clock_timestamp()`,
      })
      .where(this.guard(input))
      .returning({ id: events.id });
    return { outcome: rows.length ? 'applied' : 'stale_claim' };
  }

  async retryLater(
    input: InboundClaimGuard & {
      nextAttemptAt: string;
      failedOperation: string;
    },
  ): Promise<InboundWriteResult> {
    const rows = await this.db
      .update(events)
      .set({
        state: 'pending',
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: input.nextAttemptAt,
        failedOperation: input.failedOperation,
      })
      .where(this.guard(input, false))
      .returning({ id: events.id });
    return { outcome: rows.length ? 'applied' : 'stale_claim' };
  }
}
