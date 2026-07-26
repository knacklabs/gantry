import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';

import type {
  ObserverFeedbackAction,
  ObserverInsightType,
  ObserverOwnerActionInsight,
  ObserverOwnerActionResult,
} from '../../../../domain/ports/observer-insights.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import {
  Deliveries,
  Insights,
  mapInsight,
} from './observer-insight-repository.postgres.helpers.js';

const Feedback = pgSchema.observerInsightFeedbackPostgres;
const Suppressions = pgSchema.observerInsightTypeSuppressionsPostgres;

export async function findInsightForOwnerAction(
  db: CanonicalDb,
  input: {
    appId: string;
    recipient: string;
    insightId: string;
  },
): Promise<ObserverOwnerActionInsight | null> {
  const [row] = await db
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

export async function applyOwnerAction(
  db: CanonicalDb,
  input: {
    appId: string;
    recipient: string;
    actorUserId: string;
    insightId: string;
    action: ObserverFeedbackAction;
    nowIso: string;
    snoozeMs: number;
    suppressMs: number;
    suppressThreshold: number;
  },
): Promise<ObserverOwnerActionResult> {
  return db.transaction(async (tx) => {
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
          and(eq(Insights.id, input.insightId), eq(Insights.state, 'cooldown')),
        );
      return { outcome: 'applied' };
    }

    if (input.action === 'dismiss') {
      await tx
        .update(Insights)
        .set({ state: 'dropped', updatedAt: input.nowIso })
        .where(
          and(eq(Insights.id, input.insightId), eq(Insights.state, 'cooldown')),
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
          and(eq(Insights.id, input.insightId), eq(Insights.state, 'cooldown')),
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

export async function listOwnerActionsForInsights(
  db: CanonicalDb,
  input: {
    appId: string;
    recipient: string;
    insightIds: string[];
  },
): Promise<Map<string, ObserverFeedbackAction>> {
  if (input.insightIds.length === 0) return new Map();
  const rows = await db
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
    // newest-by-time always wins; the terminal-over-snooze preference only
    // breaks an EQUAL timestamp; id DESC is the final deterministic tiebreak.
    .orderBy(
      desc(Feedback.createdAt),
      sql`(${Feedback.action} = 'snooze') asc`,
      desc(Feedback.id),
    );
  // Ordered end-state-first; keep the first action seen per insight.
  const actions = new Map<string, ObserverFeedbackAction>();
  for (const row of rows) {
    if (!actions.has(row.insightId)) {
      actions.set(row.insightId, row.action as ObserverFeedbackAction);
    }
  }
  return actions;
}

export async function listActiveSuppressedTypes(
  db: CanonicalDb,
  input: {
    appId: string;
    recipient: string;
    nowIso: string;
  },
): Promise<Set<ObserverInsightType>> {
  // Served by the (app_id, recipient, insight_type) PK prefix. Only rows
  // whose window is still open (suppressed_until > now) count; NULL/expired
  // rows are excluded by gt, so a lapsed suppression resumes surfacing.
  const rows = await db
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
