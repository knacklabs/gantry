import { randomUUID } from 'node:crypto';

import { and, asc, eq, gt, notExists, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  BrainDreamReview,
  BrainDreamReviewClaimInput,
  BrainDreamReviewCreateInput,
  BrainDreamReviewCreateResult,
  BrainDreamReviewRepository,
  BrainDreamReviewState,
} from '../../../../brain/brain-dream-review-repository.js';
import { isTerminalBrainDreamReviewState } from '../../../../brain/brain-dream-review-repository.js';
import * as pgSchema from '../schema/schema.js';
import { outboundDeliveriesPostgres } from '../schema/outbound-delivery.js';

type Db = NodePgDatabase<typeof pgSchema>;

const Reviews = pgSchema.brainDreamReviewsPostgres;
const Targets = pgSchema.brainDreamReviewTargetsPostgres;
const Deliveries = outboundDeliveriesPostgres;

const OPEN_TARGET_INDEX = 'idx_brain_dream_review_targets_open_unique';
const DECISION_UNIQUE = 'brain_dream_reviews_decision_id_unique';

export class PostgresBrainDreamReviewRepository implements BrainDreamReviewRepository {
  constructor(private readonly db: Db) {}

  async createBrainDreamReview(
    input: BrainDreamReviewCreateInput,
  ): Promise<BrainDreamReviewCreateResult> {
    // Collapse duplicate targets before touching the DB. Same (kind, id) with
    // the SAME expected version is redundant (keep one); with DIFFERING
    // versions it's contradictory input — reject rather than persist an
    // arbitrary snapshot version a later drift check would trust.
    const deduped = dedupTargets(input.targets);
    if (!deduped.ok) return { ok: false, conflict: 'target_version_conflict' };
    const distinctTargets = deduped.targets;

    try {
      const review = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(Reviews)
          .values({
            id: input.id,
            appId: input.appId,
            runId: input.runId ?? null,
            decisionId: input.decisionId,
            action: input.action,
            canonicalOpJson: input.canonicalOp,
            reviewSnapshotJson: input.reviewSnapshot,
            state: 'pending_review',
            reviewerUserId: input.reviewerUserId ?? null,
            reviewerConversationJid: input.reviewerConversationJid ?? null,
            reviewerProviderAccountId: input.reviewerProviderAccountId ?? null,
            createdAt: input.nowIso,
            decidedAt: null,
            outcome: null,
            error: null,
          })
          .returning();

        // Distinct targets only, so the intra-insert collision never trips the
        // partial-unique index; a genuine target_open conflict must come only
        // from ANOTHER review's open claim.
        if (distinctTargets.length > 0) {
          await tx.insert(Targets).values(
            distinctTargets.map((target) => ({
              id: `bdrt_${randomUUID().replace(/-/g, '')}`,
              reviewId: input.id,
              appId: input.appId,
              targetKind: target.targetKind,
              targetId: target.targetId,
              expectedVersion: target.expectedVersion ?? null,
              open: true,
              createdAt: input.nowIso,
            })),
          );
        }
        return mapReview(row);
      });
      return { ok: true, review };
    } catch (err) {
      const conflict = classifyConflict(err);
      if (conflict) return { ok: false, conflict };
      throw err;
    }
  }

  async findPendingBrainDreamReview(input: {
    appId: string;
    reviewId: string;
  }): Promise<BrainDreamReview | null> {
    const [row] = await this.db
      .select()
      .from(Reviews)
      .where(
        and(
          eq(Reviews.appId, input.appId),
          eq(Reviews.id, input.reviewId),
          eq(Reviews.state, 'pending_review'),
        ),
      )
      .limit(1);
    return row ? mapReview(row) : null;
  }

  async listPendingBrainDreamReviews(input: {
    appId: string;
    limit: number;
  }): Promise<BrainDreamReview[]> {
    const rows = await this.db
      .select()
      .from(Reviews)
      .where(
        and(
          eq(Reviews.appId, input.appId),
          eq(Reviews.state, 'pending_review'),
        ),
      )
      .orderBy(asc(Reviews.createdAt), asc(Reviews.id))
      .limit(clampLimit(input.limit));
    return rows.map(mapReview);
  }

  async listPendingBrainReviewsWithoutDelivery(input: {
    appId: string;
    limit: number;
    after?: { createdAt: string; id: string };
  }): Promise<BrainDreamReview[]> {
    // Anti-join: pending reviews with NO durable outbound delivery for their
    // enqueued key `brain-review:<id>` (unique on app_id + idempotency_key). The
    // recovery drain advances a (createdAt, id) keyset cursor by the last fetched
    // row, so it scans the orphan set forward exactly once — a delivered review
    // leaves the set, a failed one stays but is skipped past this pass.
    const afterCursor = input.after
      ? or(
          gt(Reviews.createdAt, input.after.createdAt),
          and(
            eq(Reviews.createdAt, input.after.createdAt),
            gt(Reviews.id, input.after.id),
          ),
        )
      : undefined;
    const rows = await this.db
      .select()
      .from(Reviews)
      .where(
        and(
          eq(Reviews.appId, input.appId),
          eq(Reviews.state, 'pending_review'),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(Deliveries)
              .where(
                and(
                  eq(Deliveries.appId, input.appId),
                  eq(
                    Deliveries.idempotencyKey,
                    sql`${'brain-review:'} || ${Reviews.id}`,
                  ),
                ),
              ),
          ),
          ...(afterCursor ? [afterCursor] : []),
        ),
      )
      .orderBy(asc(Reviews.createdAt), asc(Reviews.id))
      .limit(clampLimit(input.limit));
    return rows.map(mapReview);
  }

  async claimBrainDreamReviewTransition(
    input: BrainDreamReviewClaimInput,
  ): Promise<{ claimed: boolean }> {
    return this.db.transaction(async (tx) => {
      const set: Partial<typeof Reviews.$inferInsert> = { state: input.to };
      if (input.reviewerUserId !== undefined) {
        set.reviewerUserId = input.reviewerUserId;
      }
      if (input.reviewerConversationJid !== undefined) {
        set.reviewerConversationJid = input.reviewerConversationJid;
      }
      if (input.reviewerProviderAccountId !== undefined) {
        set.reviewerProviderAccountId = input.reviewerProviderAccountId;
      }
      if (input.outcome !== undefined) set.outcome = input.outcome;
      if (input.error !== undefined) set.error = input.error;
      if (isTerminalBrainDreamReviewState(input.to)) {
        set.decidedAt = input.decidedAt ?? input.nowIso;
      } else if (input.decidedAt !== undefined) {
        set.decidedAt = input.decidedAt;
      }

      const claimed = await tx
        .update(Reviews)
        .set(set)
        .where(
          and(
            eq(Reviews.id, input.reviewId),
            eq(Reviews.appId, input.appId),
            eq(Reviews.state, input.from),
          ),
        )
        .returning({ id: Reviews.id });
      if (claimed.length === 0) return { claimed: false };

      // Terminal transition releases the target claims so a later proposal can
      // own them again (raced approvals fail their own claim, never partial).
      if (isTerminalBrainDreamReviewState(input.to)) {
        await tx
          .update(Targets)
          .set({ open: false })
          .where(
            and(eq(Targets.reviewId, input.reviewId), eq(Targets.open, true)),
          );
      }
      return { claimed: true };
    });
  }
}

// Map a unique-violation (23505) to the typed create conflict. A plain unique
// INDEX still reports its index name in err.constraint, so the open-target
// index and the decision-id constraint are both detectable without throwing.
// Drizzle wraps the driver error, so walk the `cause` chain to reach the pg row.
function classifyConflict(
  err: unknown,
): 'target_open' | 'decision_exists' | null {
  let current: unknown = err;
  for (
    let depth = 0;
    current && typeof current === 'object' && depth < 5;
    depth++
  ) {
    const e = current as {
      code?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (e.code === '23505') {
      if (e.constraint === OPEN_TARGET_INDEX) return 'target_open';
      if (e.constraint === DECISION_UNIQUE) return 'decision_exists';
      return null;
    }
    current = e.cause;
  }
  return null;
}

// Collapse duplicates when a (kind, id) repeats with the SAME expected version;
// flag `ok:false` when it repeats with a DIFFERING version (contradictory).
function dedupTargets(
  targets: BrainDreamReviewCreateInput['targets'],
):
  | { ok: true; targets: BrainDreamReviewCreateInput['targets'] }
  | { ok: false } {
  const byTarget = new Map<string, string | null>();
  const distinct: BrainDreamReviewCreateInput['targets'] = [];
  for (const t of targets) {
    const key = `${t.targetKind}|${t.targetId}`;
    const version = t.expectedVersion ?? null;
    if (byTarget.has(key)) {
      if (byTarget.get(key) !== version) return { ok: false };
      continue; // redundant duplicate, keep the first occurrence
    }
    byTarget.set(key, version);
    distinct.push(t);
  }
  return { ok: true, targets: distinct };
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit) || 1, 200));
}

function mapReview(row: typeof Reviews.$inferSelect): BrainDreamReview {
  return {
    id: row.id,
    appId: row.appId,
    runId: row.runId,
    decisionId: row.decisionId,
    action: row.action,
    canonicalOp: asRecord(row.canonicalOpJson),
    reviewSnapshot: asRecord(row.reviewSnapshotJson),
    state: row.state as BrainDreamReviewState,
    reviewerUserId: row.reviewerUserId,
    reviewerConversationJid: row.reviewerConversationJid,
    reviewerProviderAccountId: row.reviewerProviderAccountId,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    outcome: row.outcome,
    error: row.error,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
