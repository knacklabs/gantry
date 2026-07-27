import { createHash } from 'node:crypto';

// Drift over the DEPENDENT set (P1). A review's targets pin the root row and its
// dependent EDGES; the op deletes/repoints those edges. Drift must key off the
// row's CONTENT, not its updated_at — ISO timestamps are not collision-proof
// revisions (finite precision, no trigger forces every substantive edit to bump
// them), so a concurrent edit that keeps/collides the timestamp would slip past
// an updated_at check and let a delete/rewrite/merge run against data the owner
// never reviewed. Snapshot time hashes the drift-relevant content; apply time
// re-reads the same fields under lock and recomputes — any difference → stale.
// Both sides route through the SAME hash logic here so the values are comparable.

// A dependent edge, described by its drift-relevant CONTENT (not updated_at):
// which relationship it is (type, endpoints, evidence). A repoint that preserves
// the timestamp still changes these, so the fingerprint catches it.
export interface DependentEdgeRow {
  id: string;
  type: string;
  fromEntityId: string;
  toEntityId: string;
  evidencePageId: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Content revision of a page target: the fields a rewrite/delete acts on. */
export function hashPageContent(page: {
  title: string;
  markdown: string;
  slug: string;
  sourceKind: string;
}): string {
  return sha256Hex(
    JSON.stringify([page.title, page.markdown, page.slug, page.sourceKind]),
  );
}

/** Content revision of an entity target (delete/merge endpoints). */
export function hashEntityContent(entity: {
  kind: string;
  name: string;
  normalizedName: string;
}): string {
  return sha256Hex(
    JSON.stringify([entity.kind, entity.name, entity.normalizedName]),
  );
}

/** Content revision of an edge target (delete_edge root). */
export function hashEdgeContent(edge: {
  type: string;
  fromEntityId: string;
  toEntityId: string;
  evidencePageId: string;
}): string {
  return sha256Hex(
    JSON.stringify([
      edge.type,
      edge.fromEntityId,
      edge.toEntityId,
      edge.evidencePageId,
    ]),
  );
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
  // The UNION of edges touching ANY of the given entities, taken as ONE query so
  // a locking reader acquires the whole set in a single deterministic order. Two
  // concurrent merges over overlapping endpoints would otherwise grab the shared
  // rows in opposite partial order and deadlock.
  edgesTouchingEntities(
    appId: string,
    entityIds: string[],
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
      return op.entityId
        ? reader.edgesTouchingEntities(appId, [op.entityId])
        : [];
    case 'merge_entities': {
      // Source edges are repointed; target edges drive dedup — both matter. Taken
      // as ONE union query so the locking reader can't deadlock two crossing merges.
      const ids = [op.sourceEntityId, op.targetEntityId].filter(
        (id): id is string => Boolean(id),
      );
      return ids.length > 0 ? reader.edgesTouchingEntities(appId, ids) : [];
    }
    default:
      // delete_edge is a graph leaf; retire_page is deferred. The root target's
      // own version is the whole drift story — no dependent set.
      return [];
  }
}

/**
 * Stable, order-independent hash of a dependent edge set: sorted, de-duped
 * `${id}:${edge content}` keys — the id catches add/remove, the content hash
 * catches a repoint/re-type/evidence change even if the timestamp is preserved.
 * An empty set hashes to a fixed value, so every op (even leaves) stores and
 * re-checks a fingerprint uniformly. Intake hashes the EXACT edges it froze into
 * the snapshot; the executor re-reads the current set under lock and hashes it
 * the same way.
 */
export function fingerprintDependentEdges(edges: DependentEdgeRow[]): string {
  const keys = [
    ...new Set(edges.map((e) => `${e.id}:${hashEdgeContent(e)}`)),
  ].sort();
  return sha256Hex(keys.join('|'));
}

/** Collect the op's dependent set via the reader, then fingerprint it. */
export async function computeDependentFingerprint(
  reader: DependentEdgeReader,
  appId: string,
  op: DependentOp,
): Promise<string> {
  return fingerprintDependentEdges(
    await collectDependentEdges(reader, appId, op),
  );
}
