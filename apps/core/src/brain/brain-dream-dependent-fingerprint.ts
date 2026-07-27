import { createHash } from 'node:crypto';

// Drift over the DEPENDENT set (P1). A review's targets pin only the root
// entity/page via its updated_at — but the op also deletes/repoints the root's
// dependent EDGES, and edges carry independent timestamps (replacePageEdges
// bumps edge rows, not the page's updated_at). So a concurrently-approved op can
// add/remove/repoint an edge in this target's dependent set WITHOUT bumping the
// root, and the root-only drift check would pass while the executor acts on a
// DIFFERENT relationship set than the owner reviewed.
//
// Fix: fingerprint the complete dependent edge set at snapshot time, re-read it
// under lock at apply time, and fail closed to `stale` on ANY difference. Both
// sides route through the SAME collection logic here so the fingerprints are
// comparable; only the reader (plain read vs FOR UPDATE) differs.

export interface DependentEdgeRow {
  id: string;
  updatedAt: string;
}

/**
 * Reader over the drift-relevant dependent EDGE set. Intake supplies a
 * BrainRepository-backed reader (plain reads); the executor supplies a
 * transaction-backed reader that locks the rows FOR UPDATE.
 */
export interface DependentEdgeReader {
  edgesByEvidencePage(
    appId: string,
    pageId: string,
  ): Promise<DependentEdgeRow[]>;
  edgesTouchingEntity(
    appId: string,
    entityId: string,
  ): Promise<DependentEdgeRow[]>;
}

export interface DependentOp {
  action?: string;
  pageId?: string;
  entityId?: string;
  sourceEntityId?: string;
  targetEntityId?: string;
}

// The complete dependent edge set the op would delete/repoint. Edges are the
// only owner-reviewed dependents; page embeddings are machine-derived (the
// backfill pass churns them independently) and are deliberately excluded so an
// out-of-band re-embed can't spuriously stale a legitimate approval.
async function collectDependentEdges(
  reader: DependentEdgeReader,
  appId: string,
  op: DependentOp,
): Promise<DependentEdgeRow[]> {
  switch (op.action) {
    case 'delete_page':
    case 'rewrite_page':
      // Cascade-deleted / re-derived edges are those whose evidence is this page.
      return op.pageId ? reader.edgesByEvidencePage(appId, op.pageId) : [];
    case 'delete_entity':
      // Cascade-deleted edges are those touching the entity (from OR to).
      return op.entityId ? reader.edgesTouchingEntity(appId, op.entityId) : [];
    case 'merge_entities': {
      // Source edges are repointed; target edges drive dedup — both matter.
      const [source, target] = await Promise.all([
        op.sourceEntityId
          ? reader.edgesTouchingEntity(appId, op.sourceEntityId)
          : [],
        op.targetEntityId
          ? reader.edgesTouchingEntity(appId, op.targetEntityId)
          : [],
      ]);
      return [...source, ...target];
    }
    default:
      // delete_edge is a graph leaf; retire_page is deferred. The root target's
      // own version is the whole drift story — no dependent set.
      return [];
  }
}

/**
 * Stable, order-independent hash of the dependent edge set: sorted, de-duped
 * `${id}:${updatedAt}` keys. An empty set hashes to a fixed value, so every op
 * (even leaves) stores and re-checks a fingerprint uniformly.
 */
export async function computeDependentFingerprint(
  reader: DependentEdgeReader,
  appId: string,
  op: DependentOp,
): Promise<string> {
  const edges = await collectDependentEdges(reader, appId, op);
  const keys = [...new Set(edges.map((e) => `${e.id}:${e.updatedAt}`))].sort();
  return createHash('sha256').update(keys.join('|'), 'utf8').digest('hex');
}
