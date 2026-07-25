import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type {
  ObserverDelivery,
  ObserverDeliveryState,
  ObserverDigestClaimMembership,
  ObserverDigestReservation,
  ObserverDigestReserveResult,
  ObserverInsightCreate,
  ObserverInsightCursor,
  ObserverInsightRepository,
  ObserverInsightType,
  ObserverInsightState,
  ObserverSubjectKey,
  ProactiveInsight,
} from '../../../../domain/ports/observer-insights.js';
import { isObserverSubjectKey } from '../../../../domain/ports/observer-insights.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const Insights = pgSchema.proactiveInsightsPostgres;
const Embeddings = pgSchema.embeddingCachePostgres;
const Deliveries = pgSchema.observerDeliveriesPostgres;
const DeliveryInsights = pgSchema.observerDeliveryInsightsPostgres;
const Cursors = pgSchema.observerInsightCursorsPostgres;
const ACTIVE_INSIGHT_STATES: ObserverInsightState[] = [
  'pending',
  'claimed',
  'sent',
  'cooldown',
];

const ALLOWED_TRANSITIONS: Record<
  ObserverInsightState,
  readonly ObserverInsightState[]
> = {
  pending: ['claimed', 'dropped'],
  claimed: ['pending', 'dropped'],
  sent: ['cooldown'],
  cooldown: ['resolved', 'dropped'],
  resolved: [],
  dropped: [],
};

export class PostgresObserverInsightRepository implements ObserverInsightRepository {
  constructor(private readonly db: CanonicalDb) {}

  async create(input: ObserverInsightCreate): Promise<ProactiveInsight> {
    assertCanonicalSubject(input.subject);
    const [row] = await this.db
      .insert(Insights)
      .values({
        id: input.id,
        appId: input.appId,
        subject: input.subject,
        insightType: input.insightType,
        title: input.title,
        summary: input.summary,
        evidenceRefs: input.evidenceRefs,
        batchSnapshotAt: input.batchSnapshotAt,
        evidenceVersion: input.evidenceVersion,
        canonicalSignature: input.canonicalSignature,
        signatureEmbeddingRef: input.signatureEmbeddingRef ?? null,
        confidence: input.confidence,
        priorityScore: input.priorityScore,
        state: 'pending',
        cooldownUntil: null,
        resolvedAt: null,
        surfacedAt: null,
        recipient: input.recipient,
        deliveryId: null,
        createdAt: input.nowIso,
        updatedAt: input.nowIso,
      })
      .returning();
    return mapInsight(row);
  }

  async listPendingForSubject(input: {
    appId: string;
    subject: ObserverSubjectKey;
    limit: number;
  }): Promise<ProactiveInsight[]> {
    assertCanonicalSubject(input.subject);
    const rows = await this.db
      .select()
      .from(Insights)
      .where(
        and(
          eq(Insights.appId, input.appId),
          eq(Insights.subject, input.subject),
          eq(Insights.state, 'pending'),
        ),
      )
      .orderBy(
        desc(Insights.priorityScore),
        asc(Insights.createdAt),
        asc(Insights.id),
      )
      .limit(clampLimit(input.limit));
    return rows.map(mapInsight);
  }

  async list(input: {
    appId: string;
    subject?: ObserverSubjectKey;
    state?: ObserverInsightState;
    insightType?: ObserverInsightType;
    limit: number;
    before?: { createdAt: string; id: string };
  }): Promise<ProactiveInsight[]> {
    if (input.subject) assertCanonicalSubject(input.subject);
    const rows = await this.db
      .select()
      .from(Insights)
      .where(and(...insightFilters(input), keysetFilter(input.before)))
      .orderBy(desc(Insights.createdAt), desc(Insights.id))
      .limit(clampPageLimit(input.limit));
    return rows.map(mapInsight);
  }

  async count(input: {
    appId: string;
    subject?: ObserverSubjectKey;
    state?: ObserverInsightState;
    insightType?: ObserverInsightType;
  }): Promise<number> {
    if (input.subject) assertCanonicalSubject(input.subject);
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(Insights)
      .where(and(...insightFilters(input)));
    return Number(row?.count ?? 0);
  }

  async findBySignature(input: {
    appId: string;
    canonicalSignature: string;
    subject: ObserverSubjectKey;
  }): Promise<ProactiveInsight | null> {
    assertCanonicalSubject(input.subject);
    const [row] = await this.db
      .select()
      .from(Insights)
      .where(
        and(
          eq(Insights.subject, input.subject),
          eq(Insights.appId, input.appId),
          eq(Insights.canonicalSignature, input.canonicalSignature),
          inArray(Insights.state, ACTIVE_INSIGHT_STATES),
        ),
      )
      .orderBy(desc(Insights.createdAt), desc(Insights.id))
      .limit(1);
    return row ? mapInsight(row) : null;
  }

  async findHistoricalBySignature(input: {
    appId: string;
    canonicalSignature: string;
    subject: ObserverSubjectKey;
  }): Promise<ProactiveInsight | null> {
    assertCanonicalSubject(input.subject);
    const [row] = await this.db
      .select()
      .from(Insights)
      .where(
        and(
          eq(Insights.subject, input.subject),
          eq(Insights.appId, input.appId),
          eq(Insights.canonicalSignature, input.canonicalSignature),
        ),
      )
      .orderBy(desc(Insights.createdAt), desc(Insights.id))
      .limit(1);
    return row ? mapInsight(row) : null;
  }

  async findSemanticDuplicate(input: {
    appId: string;
    subject: ObserverSubjectKey;
    model: string;
    dimensions: number;
    embedding: number[];
    minSimilarity: number;
  }): Promise<{ insight: ProactiveInsight; similarity: number } | null> {
    assertCanonicalSubject(input.subject);
    const vectorLiteral = `[${input.embedding.join(',')}]`;
    const similarity = sql<number>`1 - (${Embeddings.embedding} <=> ${vectorLiteral}::vector)`;
    const [row] = await this.db
      .select({ insight: Insights, similarity })
      .from(Insights)
      .innerJoin(
        Embeddings,
        and(
          eq(Embeddings.textHash, Insights.signatureEmbeddingRef),
          eq(Embeddings.model, input.model),
          eq(Embeddings.dimensions, input.dimensions),
          sql`${Embeddings.embedding} is not null`,
        ),
      )
      .where(
        and(
          eq(Insights.appId, input.appId),
          eq(Insights.subject, input.subject),
          inArray(Insights.state, ACTIVE_INSIGHT_STATES),
          sql`${similarity} >= ${input.minSimilarity}`,
        ),
      )
      .orderBy(desc(similarity), desc(Insights.createdAt), desc(Insights.id))
      .limit(1);
    return row
      ? { insight: mapInsight(row.insight), similarity: Number(row.similarity) }
      : null;
  }

  async transitionState(input: {
    id: string;
    from: ObserverInsightState;
    to: ObserverInsightState;
    nowIso: string;
    claimedAt?: string;
    cooldownUntil?: string | null;
    resolvedAt?: string | null;
  }): Promise<ProactiveInsight | null> {
    if (!ALLOWED_TRANSITIONS[input.from].includes(input.to)) {
      throw new Error(
        `Invalid observer insight transition: ${input.from} -> ${input.to}`,
      );
    }
    if (input.from === 'claimed' && !input.claimedAt) {
      throw new Error(
        'Observer claimed transition requires the expected claimedAt fence',
      );
    }
    if (input.to === 'cooldown' && !input.cooldownUntil) {
      throw new Error(
        'Observer insight cooldown transition requires cooldownUntil',
      );
    }

    const set: Partial<typeof Insights.$inferInsert> = {
      state: input.to,
      updatedAt: input.nowIso,
    };
    if (input.to === 'cooldown') {
      set.cooldownUntil = input.cooldownUntil;
    }
    if (input.to === 'resolved') {
      set.resolvedAt = input.resolvedAt ?? input.nowIso;
    }

    const [row] = await this.db
      .update(Insights)
      .set(set)
      .where(
        and(
          eq(Insights.id, input.id),
          eq(Insights.state, input.from),
          input.from === 'claimed'
            ? eq(Insights.updatedAt, input.claimedAt!)
            : undefined,
        ),
      )
      .returning();
    return row ? mapInsight(row) : null;
  }

  async recoverStaleClaims(input: {
    appId: string;
    subject: ObserverSubjectKey;
    staleBeforeIso: string;
    nowIso: string;
  }): Promise<ProactiveInsight[]> {
    assertCanonicalSubject(input.subject);
    const staleBefore = Date.parse(input.staleBeforeIso);
    const recoveryTime = Date.parse(input.nowIso);
    if (
      !Number.isFinite(staleBefore) ||
      !Number.isFinite(recoveryTime) ||
      recoveryTime <= staleBefore
    ) {
      throw new Error(
        'Observer claim recovery time must follow the stale cutoff',
      );
    }
    const rows = await this.db
      .update(Insights)
      .set({ state: 'pending', updatedAt: input.nowIso })
      .where(
        and(
          eq(Insights.appId, input.appId),
          eq(Insights.subject, input.subject),
          eq(Insights.state, 'claimed'),
          lte(Insights.updatedAt, input.staleBeforeIso),
        ),
      )
      .returning();
    return rows.map(mapInsight);
  }

  async markDelivered(input: {
    id: string;
    deliveryId: string;
    claimedAt: string;
    surfacedAt: string;
    nowIso: string;
  }): Promise<ProactiveInsight | null> {
    return this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .select({ appId: Insights.appId, recipient: Insights.recipient })
        .from(Insights)
        .where(
          and(
            eq(Insights.id, input.id),
            eq(Insights.state, 'claimed'),
            eq(Insights.updatedAt, input.claimedAt),
          ),
        )
        .limit(1);
      if (!claimed) return null;

      const [delivery] = await tx
        .select({ id: Deliveries.id })
        .from(Deliveries)
        .where(
          and(
            eq(Deliveries.id, input.deliveryId),
            eq(Deliveries.appId, claimed.appId),
            eq(Deliveries.recipient, claimed.recipient),
          ),
        )
        .limit(1);
      if (!delivery) {
        throw new Error(
          'Observer delivery must match the claimed insight app and recipient',
        );
      }

      const [row] = await tx
        .update(Insights)
        .set({
          state: 'sent',
          deliveryId: input.deliveryId,
          surfacedAt: input.surfacedAt,
          updatedAt: input.nowIso,
        })
        .where(
          and(
            eq(Insights.id, input.id),
            eq(Insights.state, 'claimed'),
            eq(Insights.updatedAt, input.claimedAt),
          ),
        )
        .returning();
      return row ? mapInsight(row) : null;
    });
  }

  async recordDelivery(input: {
    id: string;
    appId: string;
    recipient: string;
    localDay: string;
    nowIso: string;
  }): Promise<ObserverDelivery> {
    const [row] = await this.db
      .insert(Deliveries)
      .values({
        id: input.id,
        appId: input.appId,
        recipient: input.recipient,
        localDay: input.localDay,
        createdAt: input.nowIso,
      })
      .returning();
    return mapDelivery(row);
  }

  async claimPendingForDigest(input: {
    appId: string;
    recipient: string;
    limit: number;
    nowIso: string;
  }): Promise<ProactiveInsight[]> {
    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: Insights.id })
        .from(Insights)
        .where(
          and(
            eq(Insights.appId, input.appId),
            eq(Insights.recipient, input.recipient),
            eq(Insights.state, 'pending'),
          ),
        )
        .orderBy(
          desc(Insights.priorityScore),
          asc(Insights.createdAt),
          asc(Insights.id),
        )
        .limit(clampLimit(input.limit))
        .for('update', { skipLocked: true });
      if (locked.length === 0) return [];
      const rows = await tx
        .update(Insights)
        .set({ state: 'claimed', updatedAt: input.nowIso })
        .where(
          inArray(
            Insights.id,
            locked.map((row) => row.id),
          ),
        )
        .returning();
      // UPDATE ... RETURNING has no defined order; membership positions depend
      // on priority order, so re-sort by the ordered id sequence we locked.
      const order = new Map(locked.map((row, index) => [row.id, index]));
      return rows
        .map(mapInsight)
        .sort((left, right) => order.get(left.id)! - order.get(right.id)!);
    });
  }

  async reserveDigest(input: {
    id: string;
    appId: string;
    recipient: string;
    localDay: string;
    timezone: string;
    conversationJid: string;
    providerAccountId: string;
    threadId?: string | null;
    renderedDigest: string;
    contentHash: string;
    memberships: ObserverDigestClaimMembership[];
    nowIso: string;
  }): Promise<ObserverDigestReserveResult> {
    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(Deliveries)
        .values({
          id: input.id,
          appId: input.appId,
          recipient: input.recipient,
          localDay: input.localDay,
          state: 'reserved',
          timezone: input.timezone,
          conversationJid: input.conversationJid,
          providerAccountId: input.providerAccountId,
          threadId: input.threadId ?? null,
          renderedDigest: input.renderedDigest,
          contentHash: input.contentHash,
          reservedAt: input.nowIso,
          createdAt: input.nowIso,
        })
        .onConflictDoNothing({
          target: [Deliveries.appId, Deliveries.recipient, Deliveries.localDay],
        })
        .returning();

      if (inserted) {
        if (input.memberships.length > 0) {
          await tx.insert(DeliveryInsights).values(
            input.memberships.map((membership) => ({
              deliveryId: inserted.id,
              insightId: membership.insightId,
              claimedAt: membership.claimedAt,
              position: membership.position,
            })),
          );
        }
        return { reservation: mapReservation(inserted), created: true };
      }

      // Unique key already claimed this (app, recipient, day): the reservation
      // is at-most-once, so return the existing one and add no membership.
      const [existing] = await tx
        .select()
        .from(Deliveries)
        .where(
          and(
            eq(Deliveries.appId, input.appId),
            eq(Deliveries.recipient, input.recipient),
            eq(Deliveries.localDay, input.localDay),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new Error('Observer digest reservation conflict without a row');
      }
      return { reservation: mapReservation(existing), created: false };
    });
  }

  async settleDigest(input: {
    deliveryId: string;
    outboundDeliveryId: string;
    cooldownUntil: string;
    nowIso: string;
  }): Promise<ObserverDigestReservation | null> {
    return this.db.transaction(async (tx) => {
      const [delivery] = await tx
        .select()
        .from(Deliveries)
        .where(eq(Deliveries.id, input.deliveryId))
        .limit(1);
      if (!delivery) return null;
      // Idempotent: an already-settled delivery is returned untouched (never
      // overwrite its outboundDeliveryId/timestamps). Never settle a `failed`
      // delivery.
      if (delivery.state === 'settled') return mapReservation(delivery);
      if (delivery.state !== 'reserved' && delivery.state !== 'sent') {
        return null;
      }

      const memberships = await tx
        .select()
        .from(DeliveryInsights)
        .where(eq(DeliveryInsights.deliveryId, input.deliveryId));

      for (const membership of memberships) {
        const [sent] = await tx
          .update(Insights)
          .set({
            state: 'sent',
            deliveryId: input.deliveryId,
            surfacedAt: input.nowIso,
            updatedAt: input.nowIso,
          })
          .where(
            and(
              eq(Insights.id, membership.insightId),
              eq(Insights.state, 'claimed'),
              eq(Insights.updatedAt, membership.claimedAt),
            ),
          )
          .returning({ id: Insights.id });
        if (!sent) {
          // Fence didn't match: this member was NOT sent. Leaving it `claimed`
          // under a settled delivery strands it forever (recover excludes
          // settled-delivery members). Release it so recovery/next digest can
          // reclaim it.
          await tx
            .update(Insights)
            .set({ state: 'pending', updatedAt: input.nowIso })
            .where(
              and(
                eq(Insights.id, membership.insightId),
                eq(Insights.state, 'claimed'),
              ),
            );
          continue;
        }
        // The row is locked by the update above for the rest of this txn, so
        // the state='sent' guard alone is a sound fence for the cooldown step.
        await tx
          .update(Insights)
          .set({
            state: 'cooldown',
            cooldownUntil: input.cooldownUntil,
            updatedAt: input.nowIso,
          })
          .where(
            and(
              eq(Insights.id, membership.insightId),
              eq(Insights.state, 'sent'),
            ),
          );
      }

      const [settled] = await tx
        .update(Deliveries)
        .set({
          state: 'settled',
          outboundDeliveryId: input.outboundDeliveryId,
          sentAt: delivery.sentAt ?? input.nowIso,
          settledAt: input.nowIso,
        })
        .where(
          and(
            eq(Deliveries.id, input.deliveryId),
            inArray(Deliveries.state, ['reserved', 'sent']),
          ),
        )
        .returning();
      return settled ? mapReservation(settled) : null;
    });
  }

  async recoverStaleDigestClaims(input: {
    appId: string;
    staleBeforeIso: string;
    nowIso: string;
  }): Promise<ProactiveInsight[]> {
    const staleBefore = Date.parse(input.staleBeforeIso);
    const recoveryTime = Date.parse(input.nowIso);
    if (
      !Number.isFinite(staleBefore) ||
      !Number.isFinite(recoveryTime) ||
      recoveryTime <= staleBefore
    ) {
      throw new Error(
        'Observer claim recovery time must follow the stale cutoff',
      );
    }
    const rows = await this.db
      .update(Insights)
      .set({ state: 'pending', updatedAt: input.nowIso })
      .where(
        and(
          eq(Insights.appId, input.appId),
          eq(Insights.state, 'claimed'),
          lte(Insights.updatedAt, input.staleBeforeIso),
          sql`${Insights.id} NOT IN (
            SELECT ${DeliveryInsights.insightId}
            FROM ${DeliveryInsights}
            INNER JOIN ${Deliveries}
              ON ${Deliveries.id} = ${DeliveryInsights.deliveryId}
            WHERE ${Deliveries.state} IN ('reserved', 'sent', 'settled')
          )`,
        ),
      )
      .returning();
    return rows.map(mapInsight);
  }

  async getInsightCursor(
    appId: string,
    subject: ObserverSubjectKey,
  ): Promise<ObserverInsightCursor | null> {
    assertCanonicalSubject(subject);
    const [row] = await this.db
      .select()
      .from(Cursors)
      .where(and(eq(Cursors.appId, appId), eq(Cursors.subject, subject)))
      .limit(1);
    return row?.cursorUpdatedAt && row.cursorPageId
      ? {
          updatedAt: toIso(row.cursorUpdatedAt),
          pageId: row.cursorPageId,
        }
      : null;
  }

  async saveInsightCursor(
    appId: string,
    subject: ObserverSubjectKey,
    cursor: ObserverInsightCursor,
    expectedCursor: ObserverInsightCursor | null,
    nowIso: string,
  ): Promise<boolean> {
    assertCanonicalSubject(subject);
    if (expectedCursor && compareInsightCursors(cursor, expectedCursor) <= 0) {
      return false;
    }
    if (!expectedCursor) {
      const rows = await this.db
        .insert(Cursors)
        .values({
          appId,
          subject,
          cursorUpdatedAt: cursor.updatedAt,
          cursorPageId: cursor.pageId,
          updatedAt: nowIso,
        })
        .onConflictDoNothing({ target: [Cursors.appId, Cursors.subject] })
        .returning({ appId: Cursors.appId });
      return rows.length === 1;
    }

    const rows = await this.db
      .update(Cursors)
      .set({
        cursorUpdatedAt: cursor.updatedAt,
        cursorPageId: cursor.pageId,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(Cursors.appId, appId),
          eq(Cursors.subject, subject),
          eq(Cursors.cursorUpdatedAt, expectedCursor.updatedAt),
          eq(Cursors.cursorPageId, expectedCursor.pageId),
        ),
      )
      .returning({ appId: Cursors.appId });
    return rows.length === 1;
  }
}

function compareInsightCursors(
  left: ObserverInsightCursor,
  right: ObserverInsightCursor,
): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    throw new Error('Observer insight cursors require valid timestamps');
  }
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.pageId.localeCompare(right.pageId);
}
function insightFilters(input: {
  appId: string;
  subject?: ObserverSubjectKey;
  state?: ObserverInsightState;
  insightType?: ObserverInsightType;
}): SQL[] {
  const filters = [eq(Insights.appId, input.appId)];
  if (input.subject !== undefined) {
    filters.push(eq(Insights.subject, input.subject));
  }
  if (input.state !== undefined) {
    filters.push(eq(Insights.state, input.state));
  }
  if (input.insightType !== undefined) {
    filters.push(eq(Insights.insightType, input.insightType));
  }
  return filters;
}

function keysetFilter(
  before: { createdAt: string; id: string } | undefined,
): SQL | undefined {
  if (!before) return undefined;
  return or(
    lt(Insights.createdAt, before.createdAt),
    and(eq(Insights.createdAt, before.createdAt), lt(Insights.id, before.id)),
  );
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(limit, 100));
}

function clampPageLimit(limit: number): number {
  return Math.max(1, Math.min(limit, 101));
}

function assertCanonicalSubject(
  subject: string,
): asserts subject is ObserverSubjectKey {
  if (!isObserverSubjectKey(subject)) {
    throw new Error(
      'Observer insight subject must be a valid observer subject key',
    );
  }
}

function mapInsight(row: typeof Insights.$inferSelect): ProactiveInsight {
  return {
    id: row.id,
    appId: row.appId,
    subject: row.subject as ObserverSubjectKey,
    insightType: row.insightType as ProactiveInsight['insightType'],
    title: row.title,
    summary: row.summary,
    evidenceRefs: Array.isArray(row.evidenceRefs)
      ? (row.evidenceRefs as ProactiveInsight['evidenceRefs'])
      : [],
    batchSnapshotAt: toIso(row.batchSnapshotAt),
    evidenceVersion: row.evidenceVersion,
    canonicalSignature: row.canonicalSignature,
    signatureEmbeddingRef: row.signatureEmbeddingRef ?? null,
    confidence: row.confidence,
    priorityScore: row.priorityScore,
    state: row.state as ObserverInsightState,
    cooldownUntil: nullableIso(row.cooldownUntil),
    resolvedAt: nullableIso(row.resolvedAt),
    surfacedAt: nullableIso(row.surfacedAt),
    recipient: row.recipient,
    deliveryId: row.deliveryId ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function mapDelivery(row: typeof Deliveries.$inferSelect): ObserverDelivery {
  return {
    id: row.id,
    appId: row.appId,
    recipient: row.recipient,
    localDay: row.localDay,
    createdAt: toIso(row.createdAt),
  };
}

function mapReservation(
  row: typeof Deliveries.$inferSelect,
): ObserverDigestReservation {
  return {
    id: row.id,
    appId: row.appId,
    recipient: row.recipient,
    localDay: row.localDay,
    state: row.state as ObserverDeliveryState,
    timezone: row.timezone ?? null,
    conversationJid: row.conversationJid ?? null,
    providerAccountId: row.providerAccountId ?? null,
    threadId: row.threadId ?? null,
    renderedDigest: row.renderedDigest ?? null,
    contentHash: row.contentHash ?? null,
    outboundDeliveryId: row.outboundDeliveryId ?? null,
    reservedAt: nullableIso(row.reservedAt),
    sentAt: nullableIso(row.sentAt),
    settledAt: nullableIso(row.settledAt),
    createdAt: toIso(row.createdAt),
  };
}

function nullableIso(value: string | null): string | null {
  return value ? toIso(value) : null;
}

function toIso(value: string): string {
  return new Date(value).toISOString();
}
