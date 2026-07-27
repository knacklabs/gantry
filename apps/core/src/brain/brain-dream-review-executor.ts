import { and, eq, ne, or } from 'drizzle-orm';

import { PostgresBrainRepository } from '../adapters/storage/postgres/repositories/brain-repository.postgres.js';
import type { CanonicalDb } from '../adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { nowIso } from '../shared/time/datetime.js';
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
//  approve → conditional pending_review→applying (at-most-once), then ONE tx:
//            lock targets in stable order, re-read updated_at vs expected;
//            any drift/missing → applying→stale, mutate nothing;
//            else run the per-op executor + finalize applying→applied ALL in
//            the same tx (all-or-nothing); executor throw → rollback + failed.
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
      reviewerUserId: input.reviewer.userId,
      outcome: 'rejected by owner',
    });
    if (claim.claimed) return { outcome: 'rejected', mutated: false };
    return { ...(await currentState(input)), mutated: false };
  }

  // APPROVE. Claim the review at-most-once; a lost claim never double-applies.
  const claim = await input.reviews.claimBrainDreamReviewTransition({
    appId: input.appId,
    reviewId: input.reviewId,
    from: 'pending_review',
    to: 'applying',
    nowIso: stamp,
    reviewerUserId: input.reviewer.userId,
  });
  if (!claim.claimed) return { ...(await currentState(input)), mutated: false };

  try {
    return await input.db.transaction(async (tx) => {
      const [review] = await tx
        .select()
        .from(Reviews)
        .where(
          and(eq(Reviews.appId, input.appId), eq(Reviews.id, input.reviewId)),
        )
        .limit(1);
      if (!review) {
        // Should not happen (we just claimed it) — treat as drift.
        return { outcome: 'not_found' as const, mutated: false };
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
          await finalizeInTx(tx, input.reviewId, 'stale', {
            nowIso: stamp,
            outcome: `stale: ${target.targetKind} ${target.targetId} drifted`,
          });
          return {
            outcome: 'stale' as const,
            mutated: false,
            reason: `${target.targetKind} ${target.targetId} changed since review`,
          };
        }
      }

      // All targets validated → mutate in this same transaction.
      await runOpExecutor(tx, input.appId, review, stamp);
      input.testFaultAfterMutation?.();
      await finalizeInTx(tx, input.reviewId, 'applied', {
        nowIso: stamp,
        outcome: 'applied',
      });
      return { outcome: 'applied' as const, mutated: true };
    });
  } catch (error) {
    // The mutation rolled back with the transaction; record the failure out of
    // band so the durable state reflects it (review stays out of pending).
    const message = error instanceof Error ? error.message : String(error);
    await input.reviews.claimBrainDreamReviewTransition({
      appId: input.appId,
      reviewId: input.reviewId,
      from: 'applying',
      to: 'failed',
      nowIso: stamp,
      decidedAt: stamp,
      outcome: 'failed',
      error: message,
    });
    return { outcome: 'failed', mutated: false, reason: message };
  }
}

type TargetRow = typeof Targets.$inferSelect;
type Tx = Parameters<Parameters<CanonicalDb['transaction']>[0]>[0];

async function lockAndReadVersion(
  tx: Tx,
  appId: string,
  target: TargetRow,
): Promise<string | null> {
  if (target.targetKind === 'page') {
    const [row] = await tx
      .select({ updatedAt: Pages.updatedAt })
      .from(Pages)
      .where(and(eq(Pages.appId, appId), eq(Pages.id, target.targetId)))
      .for('update')
      .limit(1);
    return row?.updatedAt ?? null;
  }
  if (target.targetKind === 'entity') {
    const [row] = await tx
      .select({ updatedAt: Entities.updatedAt })
      .from(Entities)
      .where(and(eq(Entities.appId, appId), eq(Entities.id, target.targetId)))
      .for('update')
      .limit(1);
    return row?.updatedAt ?? null;
  }
  const [row] = await tx
    .select({ updatedAt: Edges.updatedAt })
    .from(Edges)
    .where(and(eq(Edges.appId, appId), eq(Edges.id, target.targetId)))
    .for('update')
    .limit(1);
  return row?.updatedAt ?? null;
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

async function finalizeInTx(
  tx: Tx,
  reviewId: string,
  to: 'applied' | 'stale',
  fields: { nowIso: string; outcome: string },
): Promise<void> {
  await tx
    .update(Reviews)
    .set({ state: to, decidedAt: fields.nowIso, outcome: fields.outcome })
    .where(and(eq(Reviews.id, reviewId), eq(Reviews.state, 'applying')));
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
