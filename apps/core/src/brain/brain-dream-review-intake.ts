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
import {
  fingerprintDependentEdges,
  hashPageContent,
  hashEntityContent,
  hashEdgeContent,
  type DependentEdgeRow,
} from './brain-dream-dependent-fingerprint.js';
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

  const { snapshot, dependentEdges } = await buildSnapshot(
    deps.repository,
    deps.appId,
    parsed.op,
    resolved,
  );

  // Pin the COMPLETE dependent edge set (P1): hash the EXACT edges frozen into
  // the snapshot above (single read — the owner's card and the stored
  // fingerprint describe the same set; no window for an edge to shift between a
  // display read and a separate fingerprint read). The executor re-reads the
  // current set under lock and fails closed to `stale` on any difference.
  snapshot.dependentFingerprint = fingerprintDependentEdges(dependentEdges);

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
// surfaced). expected_version = a HASH of the row's drift-relevant CONTENT (not
// updated_at, which isn't a collision-proof revision), so a timestamp-preserving
// edit still drifts. merge_entities yields TWO entity targets.
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
        targets: [target('page', page.id, hashPageContent(page))],
      };
    }
    case 'delete_entity': {
      const entity = await repository.getEntityById(appId, op.entityId);
      if (!entity) return notFound('entity', op.entityId);
      return {
        ok: true,
        entity,
        targets: [target('entity', entity.id, hashEntityContent(entity))],
      };
    }
    case 'delete_edge': {
      const edge = await repository.getEdgeById(appId, op.edgeId);
      if (!edge) return notFound('edge', op.edgeId);
      return {
        ok: true,
        edge,
        targets: [target('edge', edge.id, hashEdgeContent(edge))],
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
          target('entity', sourceEntity.id, hashEntityContent(sourceEntity)),
          target('entity', targetEntity.id, hashEntityContent(targetEntity)),
        ],
      };
    }
  }
}

interface BuiltSnapshot {
  snapshot: Record<string, unknown>;
  // The EXACT dependent edges frozen into the snapshot — fingerprinted by the
  // caller so the card and the drift hash describe one consistent read.
  dependentEdges: DependentEdgeRow[];
}

const edgeRow = (edge: BrainEdge): DependentEdgeRow => ({
  id: edge.id,
  type: edge.type,
  fromEntityId: edge.fromEntityId,
  toEntityId: edge.toEntityId,
  evidencePageId: edge.evidencePageId,
});

// Immutable human-review snapshot: before/after where applicable + the
// dependents that would cascade. Read-only; frozen at creation. T3/T4
// revalidate the live store against this. Returns the dependent edges it froze
// so the caller fingerprints the SAME set (single read).
async function buildSnapshot(
  repository: BrainRepository,
  appId: string,
  op: ParsedDestructiveOp,
  resolved: Extract<ResolvedTargets, { ok: true }>,
): Promise<BuiltSnapshot> {
  switch (op.action) {
    case 'rewrite_page': {
      const page = resolved.page!;
      const graph = await repository.graphForPages(appId, [page.id]);
      return {
        snapshot: {
          action: op.action,
          before: pageView(page),
          after: { title: op.title ?? page.title, markdown: op.markdown },
          dependents: { edges: graph.edges.map(edgeView) },
        },
        dependentEdges: graph.edges.map(edgeRow),
      };
    }
    case 'delete_page': {
      const page = resolved.page!;
      const graph = await repository.graphForPages(appId, [page.id]);
      const embeddings = await repository.countPageEmbeddings(appId, page.id);
      return {
        snapshot: {
          action: op.action,
          before: pageView(page),
          dependents: { edges: graph.edges.map(edgeView), embeddings },
        },
        dependentEdges: graph.edges.map(edgeRow),
      };
    }
    case 'delete_entity': {
      const entity = resolved.entity!;
      const edges = await repository.listEdgesForEntity(appId, entity.id);
      return {
        snapshot: {
          action: op.action,
          before: entityView(entity),
          dependents: { edges: edges.map(edgeView) },
        },
        dependentEdges: edges.map(edgeRow),
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
        snapshot: {
          action: op.action,
          before: {
            ...edgeView(edge),
            fromEntityName: from?.name,
            toEntityName: to?.name,
          },
        },
        // A single edge is a graph leaf — the root target's own version covers
        // it, so there is no dependent set to fingerprint.
        dependentEdges: [],
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
        snapshot: {
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
        },
        // Union of both endpoints' edges — the set the executor locks + hashes.
        dependentEdges: [...sourceEdges, ...targetEdges].map(edgeRow),
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
