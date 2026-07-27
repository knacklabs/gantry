import { and, asc, eq, inArray, ne, or } from 'drizzle-orm';

import { PostgresBrainRepository } from '../adapters/storage/postgres/repositories/brain-repository.postgres.js';
import type { CanonicalDb } from '../adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { nowIso } from '../shared/time/datetime.js';
import {
  computeDependentFingerprint,
  hashPageContent,
  hashEntityContent,
  hashEdgeContent,
  type DependentEdgeReader,
  type DependentOp,
} from './brain-dream-dependent-fingerprint.js';
import { parseBrainMarkdown } from './brain-page-ingest.js';
import type {
  BrainDreamReviewRepository,
  BrainDreamReviewState,
} from './brain-dream-review-repository.js';
import { replaceBrainPageGraph } from './brain-service.js';

const Reviews = pgSchema.brainDreamReviewsPostgres;
const Targets = pgSchema.brainDreamReviewTargetsPostgres;
const Pages = pgSchema.brainPagesPostgres;
const Entities = pgSchema.brainEntitiesPostgres;
const Edges = pgSchema.brainEdgesPostgres;
const Embeddings = pgSchema.brainPageEmbeddingsPostgres;

// Recoverable infra errors that can surface from the mutation and must NOT be
// persisted as terminal `failed`: deadlock, serialization failure, lock-not-
// available, statement/query timeout. Walk the pg error `.cause` chain (drizzle
// wraps the driver error) like T1's conflict classifier.
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available
  '57014', // query_canceled (statement timeout)
]);

function isRetryableDbError(err: unknown): boolean {
  let current: unknown = err;
  for (
    let depth = 0;
    current && typeof current === 'object' && depth < 5;
    depth++
  ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && RETRYABLE_SQLSTATES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface BrainDreamReviewDecisionInput {
  db: CanonicalDb;
  reviews: BrainDreamReviewRepository;
  appId: string;
  reviewId: string;
  decision: 'approve' | 'reject';
  reviewer: {
    userId: string;
    conversationJid: string;
    providerAccountId: string;
  };
  nowIso?: string;
  // Test-only fault seam: called INSIDE the apply transaction, right after the
  // per-op mutation and before the terminal transition, to prove all-or-nothing
  // rollback. Undefined in production.
  // ponytail: test hook, not a production knob.
  testFaultAfterMutation?: () => void;
}

export interface BrainDreamReviewDecisionResult {
  // The review's resulting (or already-recorded) state.
  outcome: BrainDreamReviewState | 'not_found';
  // True only when this call performed the brain mutation.
  mutated: boolean;
  reason?: string;
}

// Owner-decision executor for a destructive brain-dream review. The FIRST task
// that mutates the brain, so every path is fail-closed:
//  reject  → conditional pending_review→rejected, no mutation.
//  approve → ONE transaction: lock the review row FOR UPDATE (at-most-once), then
//            lock targets + re-read updated_at vs expected AND re-check the
//            dependent-edge fingerprint; any drift/missing → stale, mutate
//            nothing; else run the per-op executor inside a SAVEPOINT and finalize
//            to applied — all in the same tx (all-or-nothing). A mutation error
//            rolls back the savepoint (brain unchanged) and records `failed`
//            durably in the SAME tx; a crash rolls the whole tx back to
//            pending_review (re-clickable) — the review is never stranded.
export async function executeBrainDreamReviewDecision(
  input: BrainDreamReviewDecisionInput,
): Promise<BrainDreamReviewDecisionResult> {
  const stamp = input.nowIso ?? nowIso();
  if (input.decision === 'reject') {
    const claim = await input.reviews.claimBrainDreamReviewTransition({
      appId: input.appId,
      reviewId: input.reviewId,
      from: 'pending_review',
      to: 'rejected',
      nowIso: stamp,
      decidedAt: stamp,
      // Full reviewer identity (P2 audit): user id alone can't identify the
      // principal since ids overlap across providers/accounts.
      reviewerUserId: input.reviewer.userId,
      reviewerConversationJid: input.reviewer.conversationJid,
      reviewerProviderAccountId: input.reviewer.providerAccountId,
      outcome: 'rejected by owner',
    });
    if (claim.claimed) return { outcome: 'rejected', mutated: false };
    return { ...(await currentState(input)), mutated: false };
  }

  // APPROVE — one transaction. A genuine infra failure (connection loss, or a
  // terminal-state write error) propagates: the whole tx rolls back to
  // pending_review and the caller reports it as transient (buttons stay). Only
  // the per-op MUTATION is caught (below) so `failed` can be recorded durably.
  return input.db.transaction(async (tx) => {
    // Lock the review row FOR UPDATE. This is the at-most-once gate: a second
    // concurrent approve blocks here, then sees the terminal state the winner
    // committed and returns without mutating.
    const [review] = await tx
      .select()
      .from(Reviews)
      .where(
        and(eq(Reviews.appId, input.appId), eq(Reviews.id, input.reviewId)),
      )
      .for('update')
      .limit(1);
    if (!review) return { outcome: 'not_found' as const, mutated: false };
    if (review.state !== 'pending_review') {
      return {
        outcome: review.state as BrainDreamReviewState,
        mutated: false,
      };
    }

    const targets = await tx
      .select()
      .from(Targets)
      .where(eq(Targets.reviewId, input.reviewId));

    // Lock every target row in a STABLE order (kind, id) and re-read its
    // current updated_at. Any mismatch or missing row → fail closed to stale.
    const ordered = [...targets].sort(
      (a, b) =>
        a.targetKind.localeCompare(b.targetKind) ||
        a.targetId.localeCompare(b.targetId),
    );
    for (const target of ordered) {
      const current = await lockAndReadVersion(tx, input.appId, target);
      if (current === null || current !== target.expectedVersion) {
        await setTerminalInTx(tx, input.reviewId, 'stale', {
          nowIso: stamp,
          outcome: `stale: ${target.targetKind} ${target.targetId} drifted`,
          reviewer: input.reviewer,
        });
        return {
          outcome: 'stale' as const,
          mutated: false,
          reason: `${target.targetKind} ${target.targetId} changed since review`,
        };
      }
    }

    // Root rows validated. Now bind the approval to the exact DEPENDENT edge set
    // the owner saw (P1): re-read it under lock and compare to the snapshot
    // fingerprint. Any added/removed/repointed/re-versioned edge → fail closed.
    const storedFingerprint = (
      review.reviewSnapshotJson as { dependentFingerprint?: unknown }
    )?.dependentFingerprint;
    const currentFingerprint = await computeDependentFingerprint(
      executorDependentReader(tx),
      input.appId,
      review.canonicalOpJson as DependentOp,
    );
    if (storedFingerprint !== currentFingerprint) {
      await setTerminalInTx(tx, input.reviewId, 'stale', {
        nowIso: stamp,
        outcome: 'stale: dependent set drifted since review',
        reviewer: input.reviewer,
      });
      return {
        outcome: 'stale' as const,
        mutated: false,
        reason: 'dependent set changed since review',
      };
    }

    // All targets + dependents validated → mutate inside a SAVEPOINT so a per-op
    // error rolls back ONLY the mutation (brain unchanged) while this tx stays
    // open to record `failed` durably.
    try {
      await tx.transaction(async (sp) => {
        await runOpExecutor(sp, input.appId, review, stamp);
        input.testFaultAfterMutation?.();
      });
    } catch (error) {
      // A RETRYABLE infra error (deadlock/serialization/lock+statement timeout)
      // can fire after the savepoint rolled back the mutation. Do NOT persist
      // `failed` (that closes targets + strips the owner's buttons); RETHROW so
      // the OUTER tx aborts and the review stays pending_review — re-clickable.
      // Only DETERMINISTIC op errors (validation/logic) become terminal failed.
      if (isRetryableDbError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      await setTerminalInTx(tx, input.reviewId, 'failed', {
        nowIso: stamp,
        outcome: 'failed',
        error: message,
        reviewer: input.reviewer,
      });
      return {
        outcome: 'failed' as const,
        mutated: false,
        reason: message,
      };
    }
    await setTerminalInTx(tx, input.reviewId, 'applied', {
      nowIso: stamp,
      outcome: 'applied',
      reviewer: input.reviewer,
    });
    return { outcome: 'applied' as const, mutated: true };
  });
}

type TargetRow = typeof Targets.$inferSelect;
type Tx = Parameters<Parameters<CanonicalDb['transaction']>[0]>[0];

// Dependent-edge reader that LOCKS the rows FOR UPDATE inside the apply tx, so
// the fingerprint re-read and the subsequent mutation see a set no concurrent
// writer can change out from under them. Same row sets as the intake reader.
function executorDependentReader(tx: Tx): DependentEdgeReader {
  // Every locking query is ORDER BY id: a single, stable global lock order over
  // the union so no two concurrent approvals can acquire the shared rows in
  // opposite partial order (deadlock).
  const edgeContentColumns = {
    id: Edges.id,
    type: Edges.type,
    fromEntityId: Edges.fromEntityId,
    toEntityId: Edges.toEntityId,
    evidencePageId: Edges.evidencePageId,
  };
  return {
    edgesByEvidencePage: async (appId, pageId) =>
      tx
        .select(edgeContentColumns)
        .from(Edges)
        .where(and(eq(Edges.appId, appId), eq(Edges.evidencePageId, pageId)))
        .orderBy(asc(Edges.id))
        .for('update'),
    edgesTouchingEntities: async (appId, entityIds) =>
      entityIds.length === 0
        ? []
        : tx
            .select(edgeContentColumns)
            .from(Edges)
            .where(
              and(
                eq(Edges.appId, appId),
                or(
                  inArray(Edges.fromEntityId, entityIds),
                  inArray(Edges.toEntityId, entityIds),
                ),
              ),
            )
            .orderBy(asc(Edges.id))
            .for('update'),
  };
}

// Re-read the target row's drift-relevant CONTENT under lock and hash it the same
// way intake did (content, not updated_at) → compare to target.expectedVersion.
// A missing row returns null (→ stale). A content edit that preserved the
// timestamp still changes the hash, so it is caught.
async function lockAndReadVersion(
  tx: Tx,
  appId: string,
  target: TargetRow,
): Promise<string | null> {
  if (target.targetKind === 'page') {
    const [row] = await tx
      .select({
        title: Pages.title,
        markdown: Pages.markdown,
        slug: Pages.slug,
        sourceKind: Pages.sourceKind,
      })
      .from(Pages)
      .where(and(eq(Pages.appId, appId), eq(Pages.id, target.targetId)))
      .for('update')
      .limit(1);
    return row ? hashPageContent(row) : null;
  }
  if (target.targetKind === 'entity') {
    const [row] = await tx
      .select({
        kind: Entities.kind,
        name: Entities.name,
        normalizedName: Entities.normalizedName,
      })
      .from(Entities)
      .where(and(eq(Entities.appId, appId), eq(Entities.id, target.targetId)))
      .for('update')
      .limit(1);
    return row ? hashEntityContent(row) : null;
  }
  const [row] = await tx
    .select({
      type: Edges.type,
      fromEntityId: Edges.fromEntityId,
      toEntityId: Edges.toEntityId,
      evidencePageId: Edges.evidencePageId,
    })
    .from(Edges)
    .where(and(eq(Edges.appId, appId), eq(Edges.id, target.targetId)))
    .for('update')
    .limit(1);
  return row ? hashEdgeContent(row) : null;
}

// Dispatch to the per-op mutation. Page ops are T3; graph ops are T4 and throw
// here (→ failed, never a silent no-op). retire_page is deferred and must never
// reach the executor (intake defers it) — throw if it somehow does.
async function runOpExecutor(
  tx: Tx,
  appId: string,
  review: typeof Reviews.$inferSelect,
  nowIso: string,
): Promise<void> {
  const op = review.canonicalOpJson as { action?: string };
  const action = op?.action;
  const repo = new PostgresBrainRepository(tx as unknown as CanonicalDb);
  switch (action) {
    case 'rewrite_page':
      return rewritePage(tx, repo, appId, op as RewritePageOp);
    case 'delete_page':
      return deletePage(tx, appId, op as DeletePageOp);
    case 'delete_edge':
      return deleteEdge(tx, appId, op as DeleteEdgeOp);
    case 'delete_entity':
      return deleteEntity(tx, appId, op as DeleteEntityOp);
    case 'merge_entities':
      return mergeEntities(tx, appId, op as MergeEntitiesOp, nowIso);
    case 'retire_page':
      throw new Error('retire_page unsupported in v1');
    default:
      throw new Error(`unknown destructive op: ${String(action)}`);
  }
}

interface RewritePageOp {
  pageId: string;
  title: string | null;
  markdown: string;
}
interface DeletePageOp {
  pageId: string;
}
interface DeleteEdgeOp {
  edgeId: string;
}
interface DeleteEntityOp {
  entityId: string;
}
interface MergeEntitiesOp {
  sourceEntityId: string;
  targetEntityId: string;
}

async function rewritePage(
  tx: Tx,
  repo: PostgresBrainRepository,
  appId: string,
  op: RewritePageOp,
): Promise<void> {
  const existing = await repo.getPageById(appId, op.pageId);
  if (!existing) throw new Error(`rewrite_page target missing: ${op.pageId}`);
  // Overwrite content VERBATIM (T2 preserved markdown byte-for-byte). The repo
  // stores markdown as-is; upsert by (appId, slug) updates this same row and
  // bumps updated_at.
  await repo.upsertPage({
    appId,
    slug: existing.slug,
    title: op.title ?? existing.title,
    markdown: op.markdown,
    sourceKind: existing.sourceKind,
    sourceRef: existing.sourceRef,
    authorId: existing.authorId,
    metadata: existing.metadata,
  });
  // Re-derive edges from the new content, exactly as BrainService.write does.
  await replaceBrainPageGraph(
    repo,
    appId,
    existing.id,
    parseBrainMarkdown(op.markdown),
  );
  // Invalidate the pre-rewrite embedding IN THE SAME TX so no stale-content
  // embedding can survive an applied rewrite. The page's updated_at bump + the
  // now-absent embedding row make it a pending candidate; the existing embed
  // backfill lifecycle re-embeds the new content out-of-band (no embedder call
  // inside the transaction — that would be a non-transactional external effect).
  // ponytail: re-embed rides the standard backfill pass, not an inline call.
  await tx.delete(Embeddings).where(eq(Embeddings.pageId, op.pageId));
}

async function deletePage(
  tx: Tx,
  appId: string,
  op: DeletePageOp,
): Promise<void> {
  // Evidence edges (evidence_page_id) and page embeddings (page_id) are FK
  // ON DELETE cascade, so deleting the page row removes them in the same tx.
  await tx
    .delete(Pages)
    .where(and(eq(Pages.appId, appId), eq(Pages.id, op.pageId)));
}

// Edges are graph leaves — nothing FK-references an edge — so deleting the row
// orphans nothing. Endpoints (entities) + evidence page are untouched.
async function deleteEdge(
  tx: Tx,
  appId: string,
  op: DeleteEdgeOp,
): Promise<void> {
  await tx
    .delete(Edges)
    .where(and(eq(Edges.appId, appId), eq(Edges.id, op.edgeId)));
}

// brain_edges.from_entity_id AND to_entity_id both FK ON DELETE cascade, so
// deleting the entity removes its inbound + outbound edges in the same tx.
async function deleteEntity(
  tx: Tx,
  appId: string,
  op: DeleteEntityOp,
): Promise<void> {
  await tx
    .delete(Entities)
    .where(and(eq(Entities.appId, appId), eq(Entities.id, op.entityId)));
}

// Merge source → target. Both entities are already locked + drift-validated by
// the caller (they are the review's two targets), so a missing/changed endpoint
// fails closed to stale before we get here. Edges are repointed off a FRESH read
// under lock (the snapshot's mergeDelta is display-only). Edge uniqueness key is
// (app_id, type, from_entity_id, to_entity_id, evidence_page_id).
async function mergeEntities(
  tx: Tx,
  appId: string,
  op: MergeEntitiesOp,
  nowIso: string,
): Promise<void> {
  const { sourceEntityId: source, targetEntityId: target } = op;
  const sourceEdges = await tx
    .select()
    .from(Edges)
    .where(
      and(
        eq(Edges.appId, appId),
        or(eq(Edges.fromEntityId, source), eq(Edges.toEntityId, source)),
      ),
    )
    .for('update');
  // Deterministic order so duplicate resolution is stable.
  for (const edge of [...sourceEdges].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const from = edge.fromEntityId === source ? target : edge.fromEntityId;
    const to = edge.toEntityId === source ? target : edge.toEntityId;
    // Self-loop (source→target etc. collapses to target→target): drop it. The
    // schema has no self-edge CHECK, but a merge must not manufacture one.
    if (from === to) {
      await tx.delete(Edges).where(eq(Edges.id, edge.id));
      continue;
    }
    // Duplicate: repointing would collide with an existing edge on the unique
    // key (incl. one repointed earlier in this loop, visible in-tx). Drop the
    // redundant repointed edge rather than violate the unique index.
    const [dup] = await tx
      .select({ id: Edges.id })
      .from(Edges)
      .where(
        and(
          eq(Edges.appId, appId),
          eq(Edges.type, edge.type),
          eq(Edges.fromEntityId, from),
          eq(Edges.toEntityId, to),
          eq(Edges.evidencePageId, edge.evidencePageId),
          ne(Edges.id, edge.id),
        ),
      )
      .limit(1);
    if (dup) {
      await tx.delete(Edges).where(eq(Edges.id, edge.id));
      continue;
    }
    await tx
      .update(Edges)
      .set({ fromEntityId: from, toEntityId: to, updatedAt: nowIso })
      .where(eq(Edges.id, edge.id));
  }
  // Bump the surviving target so its graph change is visible to later drift.
  await tx
    .update(Entities)
    .set({ updatedAt: nowIso })
    .where(and(eq(Entities.appId, appId), eq(Entities.id, target)));
  await tx
    .delete(Entities)
    .where(and(eq(Entities.appId, appId), eq(Entities.id, source)));
}

// Write the terminal state + FULL reviewer identity + close open targets, all in
// the caller's tx. Safe to write unconditionally by id: the caller holds the
// review row FOR UPDATE and has verified it was pending_review.
async function setTerminalInTx(
  tx: Tx,
  reviewId: string,
  to: 'applied' | 'stale' | 'failed',
  fields: {
    nowIso: string;
    outcome: string;
    error?: string;
    reviewer: {
      userId: string;
      conversationJid: string;
      providerAccountId: string;
    };
  },
): Promise<void> {
  await tx
    .update(Reviews)
    .set({
      state: to,
      decidedAt: fields.nowIso,
      outcome: fields.outcome,
      error: fields.error ?? null,
      reviewerUserId: fields.reviewer.userId,
      reviewerConversationJid: fields.reviewer.conversationJid,
      reviewerProviderAccountId: fields.reviewer.providerAccountId,
    })
    .where(eq(Reviews.id, reviewId));
  await tx
    .update(Targets)
    .set({ open: false })
    .where(and(eq(Targets.reviewId, reviewId), eq(Targets.open, true)));
}

async function currentState(input: {
  db: CanonicalDb;
  appId: string;
  reviewId: string;
}): Promise<{ outcome: BrainDreamReviewState | 'not_found' }> {
  const [row] = await input.db
    .select({ state: Reviews.state })
    .from(Reviews)
    .where(and(eq(Reviews.appId, input.appId), eq(Reviews.id, input.reviewId)))
    .limit(1);
  return { outcome: (row?.state as BrainDreamReviewState) ?? 'not_found' };
}
