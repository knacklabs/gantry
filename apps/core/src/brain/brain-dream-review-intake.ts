import { randomUUID } from 'node:crypto';

import type {
  BrainDreamReviewRepository,
  BrainDreamReviewTargetInput,
} from './brain-dream-review-repository.js';
import {
  canonicalDestructiveOp,
  parseDestructiveOp,
  type ParsedDestructiveOp,
} from './brain-dream-op-schema.js';
import type { BrainReviewNotifier } from './brain-dream-review-notify.js';
import type { BrainRepository } from './brain-repository.js';
import type { BrainEdge, BrainEntity, BrainPage } from './brain-types.js';

export interface BrainDreamReviewIntakeDeps {
  repository: BrainRepository;
  reviews: BrainDreamReviewRepository;
  appId: string;
  runId: string;
  pageId: string | null;
  nowIso: string;
  // Owner-DM delivery of the created review (T6). Best-effort and out-of-band:
  // a delivery failure must NOT roll back the review, so it never throws here.
  notify?: BrainReviewNotifier;
}

export interface BrainDreamIntakeResult {
  outcome: 'proposed' | 'rejected';
  reason: string;
}

// Validate → resolve → snapshot → create review for ONE destructive op. Does
// NOT execute any mutation (that's T3/T4). retire_page is handled by the caller
// (deferred). Every failure path returns a rejected outcome with a specific
// reason; nothing throws for expected model-shaped or conflict cases.
export async function intakeDestructiveDreamOp(
  deps: BrainDreamReviewIntakeDeps,
  raw: unknown,
  decisionId: string,
): Promise<BrainDreamIntakeResult> {
  const parsed = parseDestructiveOp(raw);
  if (!parsed.ok) return { outcome: 'rejected', reason: parsed.reason };

  const resolved = await resolveTargets(deps.repository, deps.appId, parsed.op);
  if (!resolved.ok) return { outcome: 'rejected', reason: resolved.reason };

  const snapshot = await buildSnapshot(
    deps.repository,
    deps.appId,
    parsed.op,
    resolved,
  );

  // Journal the decision FIRST so the review's decision_id FK resolves; the
  // caller re-journals the final outcome afterwards (idempotent by id).
  await deps.repository.journalDreamDecision({
    id: decisionId,
    appId: deps.appId,
    runId: deps.runId,
    pageId: deps.pageId,
    op: canonicalDestructiveOp(parsed.op),
    outcome: 'proposed',
    reason: 'pending owner review',
  });

  const result = await deps.reviews.createBrainDreamReview({
    id: `bdrv_${randomUUID().replace(/-/g, '')}`,
    appId: deps.appId,
    runId: deps.runId,
    decisionId,
    action: parsed.op.action,
    canonicalOp: canonicalDestructiveOp(parsed.op),
    reviewSnapshot: snapshot,
    nowIso: deps.nowIso,
    targets: resolved.targets,
  });

  if (result.ok) {
    // Deliver out-of-band; swallow any failure so it never rolls back the
    // already-committed review (the pending-review list is the recovery handle).
    await deps.notify?.(result.review).catch(() => {});
    return {
      outcome: 'proposed',
      reason: `queued for owner review (${result.review.id})`,
    };
  }
  return {
    outcome: 'rejected',
    reason: `review not created: ${result.conflict}`,
  };
}

type ResolvedTargets =
  | {
      ok: true;
      targets: BrainDreamReviewTargetInput[];
      page?: BrainPage;
      entity?: BrainEntity;
      edge?: BrainEdge;
      sourceEntity?: BrainEntity;
      targetEntity?: BrainEntity;
    }
  | { ok: false; reason: string };

// Resolve the op's target row(s) from the store. A missing referenced
// page/entity/edge is a validation failure (journaled rejected, never
// surfaced). expected_version = the row's current updated_at (the locked drift
// token — see plan). merge_entities yields TWO entity targets.
async function resolveTargets(
  repository: BrainRepository,
  appId: string,
  op: ParsedDestructiveOp,
): Promise<ResolvedTargets> {
  switch (op.action) {
    case 'rewrite_page':
    case 'delete_page': {
      const page = await repository.getPageById(appId, op.pageId);
      if (!page) return notFound('page', op.pageId);
      return {
        ok: true,
        page,
        targets: [target('page', page.id, page.updatedAt)],
      };
    }
    case 'delete_entity': {
      const entity = await repository.getEntityById(appId, op.entityId);
      if (!entity) return notFound('entity', op.entityId);
      return {
        ok: true,
        entity,
        targets: [target('entity', entity.id, entity.updatedAt)],
      };
    }
    case 'delete_edge': {
      const edge = await repository.getEdgeById(appId, op.edgeId);
      if (!edge) return notFound('edge', op.edgeId);
      return {
        ok: true,
        edge,
        targets: [target('edge', edge.id, edge.updatedAt)],
      };
    }
    case 'merge_entities': {
      const sourceEntity = await repository.getEntityById(
        appId,
        op.sourceEntityId,
      );
      if (!sourceEntity) return notFound('entity', op.sourceEntityId);
      const targetEntity = await repository.getEntityById(
        appId,
        op.targetEntityId,
      );
      if (!targetEntity) return notFound('entity', op.targetEntityId);
      return {
        ok: true,
        sourceEntity,
        targetEntity,
        targets: [
          target('entity', sourceEntity.id, sourceEntity.updatedAt),
          target('entity', targetEntity.id, targetEntity.updatedAt),
        ],
      };
    }
  }
}

// Immutable human-review snapshot: before/after where applicable + the
// dependents that would cascade. Read-only; frozen at creation. T3/T4
// revalidate the live store against this.
async function buildSnapshot(
  repository: BrainRepository,
  appId: string,
  op: ParsedDestructiveOp,
  resolved: Extract<ResolvedTargets, { ok: true }>,
): Promise<Record<string, unknown>> {
  switch (op.action) {
    case 'rewrite_page': {
      const page = resolved.page!;
      const graph = await repository.graphForPages(appId, [page.id]);
      return {
        action: op.action,
        before: pageView(page),
        after: { title: op.title ?? page.title, markdown: op.markdown },
        dependents: { edges: graph.edges.map(edgeView) },
      };
    }
    case 'delete_page': {
      const page = resolved.page!;
      const graph = await repository.graphForPages(appId, [page.id]);
      const embeddings = await repository.countPageEmbeddings(appId, page.id);
      return {
        action: op.action,
        before: pageView(page),
        dependents: { edges: graph.edges.map(edgeView), embeddings },
      };
    }
    case 'delete_entity': {
      const entity = resolved.entity!;
      const edges = await repository.listEdgesForEntity(appId, entity.id);
      return {
        action: op.action,
        before: entityView(entity),
        dependents: { edges: edges.map(edgeView) },
      };
    }
    case 'delete_edge': {
      const edge = resolved.edge!;
      // Resolve endpoint names so the review card reads by NAME, not raw ids —
      // the owner has to judge WHAT relationship is being removed. Names are
      // best-effort: a missing endpoint leaves the id-only fallback in place.
      const [from, to] = await Promise.all([
        repository.getEntityById(appId, edge.fromEntityId),
        repository.getEntityById(appId, edge.toEntityId),
      ]);
      return {
        action: op.action,
        before: {
          ...edgeView(edge),
          fromEntityName: from?.name,
          toEntityName: to?.name,
        },
      };
    }
    case 'merge_entities': {
      const source = resolved.sourceEntity!;
      const target = resolved.targetEntity!;
      const [sourceEdges, targetEdges] = await Promise.all([
        repository.listEdgesForEntity(appId, source.id),
        repository.listEdgesForEntity(appId, target.id),
      ]);
      return {
        action: op.action,
        source: entityView(source),
        target: entityView(target),
        dependents: {
          sourceEdges: sourceEdges.map(edgeView),
          targetEdges: targetEdges.map(edgeView),
        },
        // Merge delta: the source's edges are the ones a later executor would
        // re-point onto the target.
        mergeDelta: { edgesToRepoint: sourceEdges.length },
      };
    }
  }
}

function target(
  kind: BrainDreamReviewTargetInput['targetKind'],
  id: string,
  updatedAt: string,
): BrainDreamReviewTargetInput {
  return { targetKind: kind, targetId: id, expectedVersion: updatedAt };
}

function notFound(kind: string, id: string): { ok: false; reason: string } {
  return { ok: false, reason: `${kind} not found: ${id}` };
}

function pageView(page: BrainPage) {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    markdown: page.markdown,
    sourceKind: page.sourceKind,
    updatedAt: page.updatedAt,
  };
}

function entityView(entity: BrainEntity) {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    updatedAt: entity.updatedAt,
  };
}

function edgeView(edge: BrainEdge) {
  return {
    id: edge.id,
    type: edge.type,
    fromEntityId: edge.fromEntityId,
    toEntityId: edge.toEntityId,
    evidencePageId: edge.evidencePageId,
    updatedAt: edge.updatedAt,
  };
}
