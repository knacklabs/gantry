import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  desc,
  eq,
  gt,
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
  ObserverDigestDeliverySummary,
  ObserverDigestReservation,
  ObserverDigestReserveResult,
  ObserverFeedbackAction,
  ObserverInsightCreate,
  ObserverInsightCursor,
  ObserverInsightRepository,
  ObserverInsightType,
  ObserverInsightState,
  ObserverOwnerActionInsight,
  ObserverOwnerActionResult,
  ObserverSubjectKey,
  ProactiveInsight,
} from '../../../../domain/ports/observer-insights.js';
import { isObserverSubjectKey } from '../../../../domain/ports/observer-insights.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import {
  Deliveries,
  Insights,
  clampLimit,
  mapInsight,
  nullableIso,
  toIso,
} from './observer-insight-repository.postgres.helpers.js';
import {
  claimPendingForDigest,
  findDigestReservation,
  findDigestReservationForInsight,
  findUnsettledDigestReservations,
  listDigestDeliveries,
  listPendingForDigest,
  recoverStaleDigestClaims,
  reserveDigest,
  settleDigest,
} from './observer-insight-repository.postgres.digest.js';

const Embeddings = pgSchema.embeddingCachePostgres;
const Cursors = pgSchema.observerInsightCursorsPostgres;
const Feedback = pgSchema.observerInsightFeedbackPostgres;
const Suppressions = pgSchema.observerInsightTypeSuppressionsPostgres;
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
  // cooldown -> cooldown is the owner "snooze" self-transition (extends the
  // cooldown window without leaving the state).
  cooldown: ['resolved', 'dropped', 'cooldown'],
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

  claimPendingForDigest(input: {
    appId: string;
    recipient: string;
    limit: number;
    nowIso: string;
  }): Promise<ProactiveInsight[]> {
    return claimPendingForDigest(this.db, input);
  }

  listPendingForDigest(input: {
    appId: string;
    recipient: string;
    limit: number;
  }): Promise<ProactiveInsight[]> {
    return listPendingForDigest(this.db, input);
  }

  listDigestDeliveries(input: {
    appId: string;
    recipient: string;
    limit: number;
  }): Promise<ObserverDigestDeliverySummary[]> {
    return listDigestDeliveries(this.db, input);
  }

  findDigestReservation(input: {
    appId: string;
    recipient: string;
    localDay: string;
  }): Promise<ObserverDigestReservation | null> {
    return findDigestReservation(this.db, input);
  }

  findDigestReservationForInsight(input: {
    appId: string;
    recipient: string;
    insightId: string;
  }): Promise<ObserverDigestReservation | null> {
    return findDigestReservationForInsight(this.db, input);
  }

  async listOwnerActionsForInsights(input: {
    appId: string;
    recipient: string;
    insightIds: string[];
  }): Promise<Map<string, ObserverFeedbackAction>> {
    if (input.insightIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        insightId: Feedback.insightId,
        action: Feedback.action,
      })
      .from(Feedback)
      .where(
        and(
          eq(Feedback.appId, input.appId),
          eq(Feedback.recipient, input.recipient),
          inArray(Feedback.insightId, input.insightIds),
        ),
      )
      .orderBy(desc(Feedback.createdAt));
    // Ordered newest-first; keep the first (latest) action seen per insight.
    const actions = new Map<string, ObserverFeedbackAction>();
    for (const row of rows) {
      if (!actions.has(row.insightId)) {
        actions.set(row.insightId, row.action as ObserverFeedbackAction);
      }
    }
    return actions;
  }

  findUnsettledDigestReservations(input: {
    appId: string;
    recipient: string;
  }): Promise<ObserverDigestReservation[]> {
    return findUnsettledDigestReservations(this.db, input);
  }

  reserveDigest(input: {
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
    return reserveDigest(this.db, input);
  }

  settleDigest(input: {
    deliveryId: string;
    outboundDeliveryId: string;
    cooldownUntil: string;
    nowIso: string;
  }): Promise<ObserverDigestReservation | null> {
    return settleDigest(this.db, input);
  }

  recoverStaleDigestClaims(input: {
    appId: string;
    staleBeforeIso: string;
    nowIso: string;
  }): Promise<ProactiveInsight[]> {
    return recoverStaleDigestClaims(this.db, input);
  }

  async findInsightForOwnerAction(input: {
    appId: string;
    recipient: string;
    insightId: string;
  }): Promise<ObserverOwnerActionInsight | null> {
    const [row] = await this.db
      .select({ insight: Insights, delivery: Deliveries })
      .from(Insights)
      .leftJoin(Deliveries, eq(Deliveries.id, Insights.deliveryId))
      .where(
        and(
          eq(Insights.id, input.insightId),
          eq(Insights.appId, input.appId),
          eq(Insights.recipient, input.recipient),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      insight: mapInsight(row.insight),
      conversationJid: row.delivery?.conversationJid ?? null,
      providerAccountId: row.delivery?.providerAccountId ?? null,
      threadId: row.delivery?.threadId ?? null,
    };
  }

  async applyOwnerAction(input: {
    appId: string;
    recipient: string;
    actorUserId: string;
    insightId: string;
    action: ObserverFeedbackAction;
    nowIso: string;
    snoozeMs: number;
    suppressMs: number;
    suppressThreshold: number;
  }): Promise<ObserverOwnerActionResult> {
    return this.db.transaction(async (tx) => {
      const [insight] = await tx
        .select()
        .from(Insights)
        .where(
          and(
            eq(Insights.id, input.insightId),
            eq(Insights.appId, input.appId),
            eq(Insights.recipient, input.recipient),
          ),
        )
        .limit(1)
        .for('update');
      if (!insight) return { outcome: 'invalid' };

      // Does this exact click (insight+actor+action) already have a row?
      const [duplicate] = await tx
        .select({ id: Feedback.id })
        .from(Feedback)
        .where(
          and(
            eq(Feedback.insightId, input.insightId),
            eq(Feedback.actorUserId, input.actorUserId),
            eq(Feedback.action, input.action),
          ),
        )
        .limit(1);

      // Terminal precedence: once an insight is settled, only an idempotent
      // replay of the action that PRODUCED that terminal state is a no-op ack.
      // Any other replayed action on a terminal insight (e.g. a delayed snooze
      // after a later resolve) is stale — the insight moved on.
      if (insight.state === 'resolved' || insight.state === 'dropped') {
        const consistentReplay =
          (insight.state === 'resolved' && input.action === 'resolve') ||
          (insight.state === 'dropped' &&
            (input.action === 'dismiss' || input.action === 'less_like_this'));
        if (duplicate && consistentReplay) {
          return { outcome: 'applied', already: true };
        }
        return { outcome: 'stale' };
      }
      // The only state an owner acts on is a delivered insight sitting in
      // cooldown; anything earlier (pending/claimed/sent) is not yet actionable.
      if (insight.state !== 'cooldown') return { outcome: 'stale' };
      // Non-terminal replay (e.g. a repeated snooze on a still-cooldown
      // insight) is idempotent.
      if (duplicate) return { outcome: 'applied', already: true };

      // Record the audit/feedback row under the idempotency key. ON CONFLICT is
      // belt-and-suspenders for a lost race the FOR UPDATE lock already prevents.
      const inserted = await tx
        .insert(Feedback)
        .values({
          id: `oif_${randomUUID().replace(/-/g, '')}`,
          appId: input.appId,
          recipient: input.recipient,
          insightId: input.insightId,
          deliveryId: insight.deliveryId,
          actorUserId: input.actorUserId,
          insightType: insight.insightType,
          action: input.action,
          createdAt: input.nowIso,
        })
        .onConflictDoNothing({
          target: [Feedback.insightId, Feedback.actorUserId, Feedback.action],
        })
        .returning({ id: Feedback.id });
      if (inserted.length === 0) return { outcome: 'applied', already: true };

      if (input.action === 'resolve') {
        await tx
          .update(Insights)
          .set({
            state: 'resolved',
            resolvedAt: input.nowIso,
            updatedAt: input.nowIso,
          })
          .where(
            and(
              eq(Insights.id, input.insightId),
              eq(Insights.state, 'cooldown'),
            ),
          );
        return { outcome: 'applied' };
      }

      if (input.action === 'dismiss') {
        await tx
          .update(Insights)
          .set({ state: 'dropped', updatedAt: input.nowIso })
          .where(
            and(
              eq(Insights.id, input.insightId),
              eq(Insights.state, 'cooldown'),
            ),
          );
        return { outcome: 'applied' };
      }

      if (input.action === 'snooze') {
        const nextCooldown = maxIso(
          insight.cooldownUntil,
          addMs(input.nowIso, input.snoozeMs),
        );
        await tx
          .update(Insights)
          .set({ cooldownUntil: nextCooldown, updatedAt: input.nowIso })
          .where(
            and(
              eq(Insights.id, input.insightId),
              eq(Insights.state, 'cooldown'),
            ),
          );
        return { outcome: 'applied' };
      }

      // less_like_this: drop this insight and count the negative signal for
      // its type, promoting to a time-boxed suppression at the threshold.
      await tx
        .update(Insights)
        .set({ state: 'dropped', updatedAt: input.nowIso })
        .where(
          and(eq(Insights.id, input.insightId), eq(Insights.state, 'cooldown')),
        );

      const suppressedUntilIfPromoted = addMs(input.nowIso, input.suppressMs);
      const [row] = await tx
        .insert(Suppressions)
        .values({
          appId: input.appId,
          recipient: input.recipient,
          insightType: insight.insightType,
          negativeCount: 1,
          suppressedUntil:
            1 >= input.suppressThreshold ? suppressedUntilIfPromoted : null,
          lastFeedbackAt: input.nowIso,
          updatedAt: input.nowIso,
        })
        .onConflictDoUpdate({
          target: [
            Suppressions.appId,
            Suppressions.recipient,
            Suppressions.insightType,
          ],
          set: {
            negativeCount: sql`${Suppressions.negativeCount} + 1`,
            // GREATEST keeps the LATER value so out-of-order negatives (actions
            // on different insights lock different rows and can arrive with an
            // earlier nowIso) can only extend, never shorten/rewind. Postgres
            // GREATEST ignores NULLs, so a NULL existing → candidate wins.
            lastFeedbackAt: sql`GREATEST(${Suppressions.lastFeedbackAt}, ${input.nowIso}::timestamptz)`,
            // Keep updated_at monotonic: the row IS changing (count++), so it
            // must never rewind below its prior value or below the row's new
            // last_feedback_at, regardless of prior state or arrival order.
            updatedAt: sql`GREATEST(${Suppressions.updatedAt}, ${Suppressions.lastFeedbackAt}, ${input.nowIso}::timestamptz)`,
            suppressedUntil: sql`CASE WHEN ${Suppressions.negativeCount} + 1 >= ${input.suppressThreshold} THEN GREATEST(${Suppressions.suppressedUntil}, ${suppressedUntilIfPromoted}::timestamptz) ELSE ${Suppressions.suppressedUntil} END`,
          },
        })
        .returning({ suppressedUntil: Suppressions.suppressedUntil });
      const suppressedUntil = row?.suppressedUntil ?? null;
      const suppressedType =
        suppressedUntil !== null &&
        Date.parse(suppressedUntil) > Date.parse(input.nowIso);
      return { outcome: 'applied', suppressedType };
    });
  }

  async listActiveSuppressedTypes(input: {
    appId: string;
    recipient: string;
    nowIso: string;
  }): Promise<Set<ObserverInsightType>> {
    // Served by the (app_id, recipient, insight_type) PK prefix. Only rows
    // whose window is still open (suppressed_until > now) count; NULL/expired
    // rows are excluded by gt, so a lapsed suppression resumes surfacing.
    const rows = await this.db
      .select({ insightType: Suppressions.insightType })
      .from(Suppressions)
      .where(
        and(
          eq(Suppressions.appId, input.appId),
          eq(Suppressions.recipient, input.recipient),
          gt(Suppressions.suppressedUntil, input.nowIso),
        ),
      );
    return new Set(rows.map((row) => row.insightType as ObserverInsightType));
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

function addMs(iso: string, ms: number): string {
  const base = Date.parse(iso);
  if (!Number.isFinite(base)) {
    throw new Error('Observer owner action requires a valid nowIso timestamp');
  }
  return new Date(base + ms).toISOString();
}

// Later of an existing cooldown (nullable) and the freshly computed one, so a
// snooze never shortens an already-longer cooldown window.
function maxIso(current: string | null, candidate: string): string {
  if (!current) return candidate;
  return Date.parse(current) >= Date.parse(candidate) ? current : candidate;
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

function mapDelivery(row: typeof Deliveries.$inferSelect): ObserverDelivery {
  return {
    id: row.id,
    appId: row.appId,
    recipient: row.recipient,
    localDay: row.localDay,
    createdAt: toIso(row.createdAt),
  };
}
