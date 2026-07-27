import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresBrainRepository } from '@core/adapters/storage/postgres/repositories/brain-repository.postgres.js';
import { PostgresBrainDreamReviewRepository } from '@core/adapters/storage/postgres/repositories/brain-dream-review-repository.postgres.js';
import { executeBrainDreamReviewDecision } from '@core/brain/brain-dream-review-executor.js';
import type { BrainPage } from '@core/brain/brain-types.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'brain-exec-app';
const NOW = '2026-07-27T10:00:00.000Z';
const REVIEWER = {
  userId: 'owner-1',
  conversationJid: 'sl:D1',
  providerAccountId: 'slack_one',
};

maybeDescribe('brain dream review decision executor', () => {
  let runtime: PostgresIntegrationRuntime;
  let repository: PostgresBrainRepository;
  let reviews: PostgresBrainDreamReviewRepository;
  let seq = 0;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'brain_exec',
    });
    await runtime.repositories.apps.saveApp({
      id: APP_ID as never,
      slug: APP_ID,
      name: 'Brain executor test',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository = new PostgresBrainRepository(runtime.service.db);
    reviews = new PostgresBrainDreamReviewRepository(runtime.service.db);
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  async function seedPage(slug: string, markdown: string): Promise<BrainPage> {
    const { page } = await repository.upsertPage({
      appId: APP_ID,
      slug,
      title: slug,
      markdown,
      sourceKind: 'user',
    });
    return page;
  }

  async function createPageReview(
    action: 'rewrite_page' | 'delete_page',
    page: BrainPage,
    canonicalExtra: Record<string, unknown> = {},
  ) {
    seq += 1;
    const decisionId = `dec-${seq}`;
    const reviewId = `rev-${seq}`;
    await repository.journalDreamDecision({
      id: decisionId,
      appId: APP_ID,
      runId: 'exec-run',
      pageId: page.id,
      op: { action },
      outcome: 'proposed',
      reason: 'test',
    });
    const result = await reviews.createBrainDreamReview({
      id: reviewId,
      appId: APP_ID,
      runId: 'exec-run',
      decisionId,
      action,
      canonicalOp: { action, version: 1, pageId: page.id, ...canonicalExtra },
      reviewSnapshot: { action },
      nowIso: NOW,
      targets: [
        {
          targetKind: 'page',
          targetId: page.id,
          expectedVersion: page.updatedAt,
        },
      ],
    });
    if (!result.ok) throw new Error(`review setup failed: ${result.conflict}`);
    return reviewId;
  }

  async function createReview(
    action: string,
    canonicalOp: Record<string, unknown>,
    targets: Array<{
      targetKind: 'page' | 'entity' | 'edge';
      targetId: string;
      expectedVersion: string;
    }>,
  ) {
    seq += 1;
    const decisionId = `dec-${seq}`;
    const reviewId = `rev-${seq}`;
    await repository.journalDreamDecision({
      id: decisionId,
      appId: APP_ID,
      runId: 'exec-run',
      pageId: null,
      op: { action },
      outcome: 'proposed',
      reason: 'test',
    });
    const result = await reviews.createBrainDreamReview({
      id: reviewId,
      appId: APP_ID,
      runId: 'exec-run',
      decisionId,
      action,
      canonicalOp: { action, version: 1, ...canonicalOp },
      reviewSnapshot: { action },
      nowIso: NOW,
      targets,
    });
    if (!result.ok) throw new Error(`review setup failed: ${result.conflict}`);
    return reviewId;
  }

  async function seedEntity(name: string) {
    const [entity] = await repository.upsertEntities(APP_ID, [
      { kind: 'person', name, normalizedName: name.toLowerCase() },
    ]);
    return entity;
  }

  async function seedEdge(
    type: 'mentions' | 'relates_to',
    fromEntityId: string,
    toEntityId: string,
    evidencePageId: string,
  ) {
    const [edge] = await repository.upsertEdges(APP_ID, evidencePageId, [
      { type, fromEntityId, toEntityId },
    ]);
    return edge;
  }

  async function edgeRow(id: string) {
    const rows = await runtime.service.pool.query<{
      from_entity_id: string;
      to_entity_id: string;
    }>(
      `SELECT from_entity_id, to_entity_id FROM ${runtime.schemaName}.brain_edges WHERE id = $1`,
      [id],
    );
    return rows.rows[0] ?? null;
  }

  async function edgeCount(where: string, params: unknown[]) {
    const rows = await runtime.service.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${runtime.schemaName}.brain_edges WHERE ${where}`,
      params,
    );
    return Number(rows.rows[0]!.count);
  }

  function decide(
    reviewId: string,
    decision: 'approve' | 'reject',
    testFaultAfterMutation?: () => void,
    appId: string = APP_ID,
  ) {
    return executeBrainDreamReviewDecision({
      db: runtime.service.db,
      reviews,
      appId,
      reviewId,
      decision,
      reviewer: REVIEWER,
      testFaultAfterMutation,
    });
  }

  async function reviewState(reviewId: string): Promise<string> {
    const rows = await runtime.service.pool.query<{ state: string }>(
      `SELECT state FROM ${runtime.schemaName}.brain_dream_reviews WHERE id = $1`,
      [reviewId],
    );
    return rows.rows[0]!.state;
  }

  async function openTargets(reviewId: string): Promise<number> {
    const rows = await runtime.service.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${runtime.schemaName}.brain_dream_review_targets WHERE review_id = $1 AND open`,
      [reviewId],
    );
    return Number(rows.rows[0]!.count);
  }

  it('approve rewrite_page: verbatim content, re-derived edges, applied, targets closed', async () => {
    const page = await seedPage('rewrite-target', 'original body');
    const markdown = '---\npeople: [Alice]\n---\nSee [[Acme]]\n\n';
    const reviewId = await createPageReview('rewrite_page', page, {
      title: 'Rewritten',
      markdown,
    });

    const result = await decide(reviewId, 'approve');
    expect(result).toMatchObject({ outcome: 'applied', mutated: true });

    const after = await repository.getPageById(APP_ID, page.id);
    expect(after!.markdown).toBe(markdown); // byte-for-byte verbatim
    expect(after!.title).toBe('Rewritten');
    const graph = await repository.graphForPages(APP_ID, [page.id]);
    expect(graph.edges).toHaveLength(1); // Alice mentions Acme, re-derived
    expect(await reviewState(reviewId)).toBe('applied');
    expect(await openTargets(reviewId)).toBe(0);
  });

  it('approve delete_page: page + cascaded edges + embeddings gone, applied', async () => {
    const page = await seedPage(
      'delete-target',
      '---\npeople: [Bob]\n---\n[[Zeta]]',
    );
    // Re-derive edges by writing through the service path once (an edge exists).
    const entities = await repository.upsertEntities(APP_ID, [
      { kind: 'person', name: 'Bob', normalizedName: 'bob' },
    ]);
    await repository.upsertEdges(APP_ID, page.id, [
      {
        type: 'mentions',
        fromEntityId: entities[0]!.id,
        toEntityId: entities[0]!.id,
      },
    ]);
    // Seed an embedding row so the FK cascade is exercised.
    await runtime.service.pool.query(
      `INSERT INTO ${runtime.schemaName}.brain_page_embeddings
         (page_id, provider, model, content_hash, dimensions, status, created_at, updated_at)
       VALUES ($1,'p','m','h',1536,'ready',$2,$2)`,
      [page.id, NOW],
    );

    const reviewId = await createPageReview('delete_page', page);
    const result = await decide(reviewId, 'approve');
    expect(result).toMatchObject({ outcome: 'applied', mutated: true });

    expect(await repository.getPageById(APP_ID, page.id)).toBeNull();
    const edges = await runtime.service.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${runtime.schemaName}.brain_edges WHERE evidence_page_id = $1`,
      [page.id],
    );
    expect(Number(edges.rows[0]!.count)).toBe(0);
    expect(await repository.countPageEmbeddings(APP_ID, page.id)).toBe(0);
    expect(await reviewState(reviewId)).toBe('applied');
  });

  it('DRIFT: a concurrent updated_at bump → stale, no mutation', async () => {
    const page = await seedPage('drift-target', 'body');
    const reviewId = await createPageReview('delete_page', page);
    // Simulate a concurrent write after the snapshot: bump updated_at.
    await runtime.service.pool.query(
      `UPDATE ${runtime.schemaName}.brain_pages SET updated_at = '2030-01-01T00:00:00.000Z' WHERE id = $1`,
      [page.id],
    );

    const result = await decide(reviewId, 'approve');
    expect(result.outcome).toBe('stale');
    expect(result.mutated).toBe(false);
    expect(await repository.getPageById(APP_ID, page.id)).not.toBeNull(); // untouched
    expect(await reviewState(reviewId)).toBe('stale');
    expect(await openTargets(reviewId)).toBe(0);
  });

  it('at-most-once: two concurrent approves apply exactly once', async () => {
    const page = await seedPage('race-target', 'body');
    const reviewId = await createPageReview('delete_page', page);

    const [a, b] = await Promise.all([
      decide(reviewId, 'approve'),
      decide(reviewId, 'approve'),
    ]);
    const mutated = [a, b].filter((r) => r.mutated).length;
    expect(mutated).toBe(1); // exactly one performed the delete
    expect(await repository.getPageById(APP_ID, page.id)).toBeNull();
    expect(await reviewState(reviewId)).toBe('applied');
  });

  it('reject: review rejected, no mutation', async () => {
    const page = await seedPage('reject-target', 'body');
    const reviewId = await createPageReview('delete_page', page);
    const result = await decide(reviewId, 'reject');
    expect(result).toMatchObject({ outcome: 'rejected', mutated: false });
    expect(await repository.getPageById(APP_ID, page.id)).not.toBeNull();
    expect(await reviewState(reviewId)).toBe('rejected');
  });

  it('executor error mid-op: transaction rolls back, review failed, brain unchanged', async () => {
    const original = 'original body';
    const page = await seedPage('fault-target', original);
    const reviewId = await createPageReview('rewrite_page', page, {
      title: 'Should Not Persist',
      markdown: '---\npeople: [Carol]\n---\n[[Nope]]\n',
    });

    const result = await decide(reviewId, 'approve', () => {
      throw new Error('injected fault after mutation');
    });
    expect(result.outcome).toBe('failed');
    expect(result.mutated).toBe(false);

    // All-or-nothing: the page write rolled back; content + edges unchanged.
    const after = await repository.getPageById(APP_ID, page.id);
    expect(after!.markdown).toBe(original);
    expect(after!.title).toBe('fault-target');
    const graph = await repository.graphForPages(APP_ID, [page.id]);
    expect(graph.edges).toHaveLength(0);
    expect(await reviewState(reviewId)).toBe('failed');
  });

  it('cross-app: a foreign appId cannot transition the review', async () => {
    const page = await seedPage('cross-app-target', 'body');
    const reviewId = await createPageReview('delete_page', page);

    // Approve/reject under a DIFFERENT app must not touch this review.
    const approve = await decide(
      reviewId,
      'approve',
      undefined,
      'intruder-app',
    );
    expect(approve.mutated).toBe(false);
    const reject = await decide(reviewId, 'reject', undefined, 'intruder-app');
    expect(reject.mutated).toBe(false);

    // The review is untouched — still pending, NOT left in applying.
    expect(await reviewState(reviewId)).toBe('pending_review');
    expect(await repository.getPageById(APP_ID, page.id)).not.toBeNull();
    // And the real owner can still act on it.
    expect((await decide(reviewId, 'approve')).outcome).toBe('applied');
  });

  it('rewrite_page invalidates the stale embedding row in the same tx', async () => {
    const page = await seedPage('embed-target', 'old content');
    await runtime.service.pool.query(
      `INSERT INTO ${runtime.schemaName}.brain_page_embeddings
         (page_id, provider, model, content_hash, dimensions, status, created_at, updated_at)
       VALUES ($1,'p','m','old-hash',1536,'ready',$2,$2)`,
      [page.id, NOW],
    );
    expect(await repository.countPageEmbeddings(APP_ID, page.id)).toBe(1);

    const reviewId = await createPageReview('rewrite_page', page, {
      title: 'Fresh',
      markdown: 'brand new content\n',
    });
    const result = await decide(reviewId, 'approve');
    expect(result).toMatchObject({ outcome: 'applied', mutated: true });

    // Stale embedding is gone; re-embed rides the backfill lifecycle.
    expect(await repository.countPageEmbeddings(APP_ID, page.id)).toBe(0);
  });

  it('approve delete_edge → edge gone, endpoints intact, applied', async () => {
    const page = await seedPage('edge-evidence', 'body');
    const a = await seedEntity('EdgeA');
    const b = await seedEntity('EdgeB');
    const edge = await seedEdge('mentions', a.id, b.id, page.id);
    const reviewId = await createReview('delete_edge', { edgeId: edge.id }, [
      {
        targetKind: 'edge',
        targetId: edge.id,
        expectedVersion: edge.updatedAt,
      },
    ]);

    const result = await decide(reviewId, 'approve');
    expect(result).toMatchObject({ outcome: 'applied', mutated: true });
    expect(await edgeRow(edge.id)).toBeNull();
    // Endpoints survive.
    expect(await repository.getEntityById(APP_ID, a.id)).not.toBeNull();
    expect(await repository.getEntityById(APP_ID, b.id)).not.toBeNull();
    expect(await reviewState(reviewId)).toBe('applied');
  });

  it('approve delete_entity → entity + inbound/outbound edges cascade, applied', async () => {
    const page = await seedPage('entity-evidence', 'body');
    const victim = await seedEntity('Victim');
    const other = await seedEntity('Other');
    const outbound = await seedEdge('mentions', victim.id, other.id, page.id);
    const inbound = await seedEdge('relates_to', other.id, victim.id, page.id);
    const reviewId = await createReview(
      'delete_entity',
      { entityId: victim.id },
      [
        {
          targetKind: 'entity',
          targetId: victim.id,
          expectedVersion: victim.updatedAt,
        },
      ],
    );

    const result = await decide(reviewId, 'approve');
    expect(result).toMatchObject({ outcome: 'applied', mutated: true });
    expect(await repository.getEntityById(APP_ID, victim.id)).toBeNull();
    expect(await edgeRow(outbound.id)).toBeNull(); // cascade
    expect(await edgeRow(inbound.id)).toBeNull(); // cascade
    expect(await repository.getEntityById(APP_ID, other.id)).not.toBeNull();
    expect(await reviewState(reviewId)).toBe('applied');
  });

  it('approve merge_entities → repoint, self-loop drop, dedup, unrelated untouched', async () => {
    const page = await seedPage('merge-evidence', 'body');
    const source = await seedEntity('Source');
    const target = await seedEntity('Target');
    const x = await seedEntity('X');
    const c = await seedEntity('C');
    const u1 = await seedEntity('U1');
    const u2 = await seedEntity('U2');

    // (1) plain repoint: X -mentions-> Source  ==>  X -mentions-> Target
    const repoint = await seedEdge('mentions', x.id, source.id, page.id);
    // (2) self-loop: Source -mentions-> Target  ==>  Target->Target (dropped)
    const selfLoop = await seedEdge('mentions', source.id, target.id, page.id);
    // (3) dedup: Source -relates_to-> C collides with existing Target -relates_to-> C
    const existing = await seedEdge('relates_to', target.id, c.id, page.id);
    const redundant = await seedEdge('relates_to', source.id, c.id, page.id);
    // (4) unrelated: U1 -mentions-> U2 (no source/target) untouched
    const unrelated = await seedEdge('mentions', u1.id, u2.id, page.id);

    const reviewId = await createReview(
      'merge_entities',
      { sourceEntityId: source.id, targetEntityId: target.id },
      [
        {
          targetKind: 'entity',
          targetId: source.id,
          expectedVersion: source.updatedAt,
        },
        {
          targetKind: 'entity',
          targetId: target.id,
          expectedVersion: target.updatedAt,
        },
      ],
    );

    const result = await decide(reviewId, 'approve');
    expect(result).toMatchObject({ outcome: 'applied', mutated: true });

    // Source entity gone.
    expect(await repository.getEntityById(APP_ID, source.id)).toBeNull();
    // (1) repointed to target.
    expect(await edgeRow(repoint.id)).toMatchObject({
      from_entity_id: x.id,
      to_entity_id: target.id,
    });
    // (2) self-loop dropped, no Target->Target edge exists.
    expect(await edgeRow(selfLoop.id)).toBeNull();
    expect(
      await edgeCount('from_entity_id = $1 AND to_entity_id = $1', [target.id]),
    ).toBe(0);
    // (3) redundant repointed edge dropped; the pre-existing target edge stays.
    expect(await edgeRow(redundant.id)).toBeNull();
    expect(await edgeRow(existing.id)).not.toBeNull();
    expect(
      await edgeCount(
        "type = 'relates_to' AND from_entity_id = $1 AND to_entity_id = $2",
        [target.id, c.id],
      ),
    ).toBe(1); // exactly one, no unique violation / double edge
    // (4) unrelated untouched.
    expect(await edgeRow(unrelated.id)).toMatchObject({
      from_entity_id: u1.id,
      to_entity_id: u2.id,
    });
    expect(await reviewState(reviewId)).toBe('applied');
  });

  it('DRIFT on a graph target → stale, no mutation', async () => {
    const page = await seedPage('merge-drift-evidence', 'body');
    const source = await seedEntity('DriftSource');
    const target = await seedEntity('DriftTarget');
    const edge = await seedEdge('mentions', source.id, target.id, page.id);
    const reviewId = await createReview(
      'merge_entities',
      { sourceEntityId: source.id, targetEntityId: target.id },
      [
        {
          targetKind: 'entity',
          targetId: source.id,
          expectedVersion: source.updatedAt,
        },
        {
          targetKind: 'entity',
          targetId: target.id,
          expectedVersion: target.updatedAt,
        },
      ],
    );
    // Concurrent write bumps the source entity after the snapshot.
    await runtime.service.pool.query(
      `UPDATE ${runtime.schemaName}.brain_entities SET updated_at = '2030-01-01T00:00:00.000Z' WHERE id = $1`,
      [source.id],
    );

    const result = await decide(reviewId, 'approve');
    expect(result.outcome).toBe('stale');
    expect(result.mutated).toBe(false);
    // Nothing mutated: source still exists, edge unchanged.
    expect(await repository.getEntityById(APP_ID, source.id)).not.toBeNull();
    expect(await edgeRow(edge.id)).toMatchObject({
      from_entity_id: source.id,
      to_entity_id: target.id,
    });
    expect(await reviewState(reviewId)).toBe('stale');
  });

  it('all-or-nothing: fault mid-merge → full rollback, review failed', async () => {
    const page = await seedPage('merge-fault-evidence', 'body');
    const source = await seedEntity('FaultSource');
    const target = await seedEntity('FaultTarget');
    const x = await seedEntity('FaultX');
    const edge = await seedEdge('mentions', x.id, source.id, page.id);
    const reviewId = await createReview(
      'merge_entities',
      { sourceEntityId: source.id, targetEntityId: target.id },
      [
        {
          targetKind: 'entity',
          targetId: source.id,
          expectedVersion: source.updatedAt,
        },
        {
          targetKind: 'entity',
          targetId: target.id,
          expectedVersion: target.updatedAt,
        },
      ],
    );

    const result = await decide(reviewId, 'approve', () => {
      throw new Error('injected fault mid-merge');
    });
    expect(result.outcome).toBe('failed');
    // Full rollback: source entity still present, edge still points to source.
    expect(await repository.getEntityById(APP_ID, source.id)).not.toBeNull();
    expect(await edgeRow(edge.id)).toMatchObject({
      from_entity_id: x.id,
      to_entity_id: source.id,
    });
    expect(await reviewState(reviewId)).toBe('failed');
  });

  it('at-most-once: two concurrent merge approves apply exactly once', async () => {
    const page = await seedPage('merge-race-evidence', 'body');
    const source = await seedEntity('RaceSource');
    const target = await seedEntity('RaceTarget');
    const x = await seedEntity('RaceX');
    await seedEdge('mentions', x.id, source.id, page.id);
    const reviewId = await createReview(
      'merge_entities',
      { sourceEntityId: source.id, targetEntityId: target.id },
      [
        {
          targetKind: 'entity',
          targetId: source.id,
          expectedVersion: source.updatedAt,
        },
        {
          targetKind: 'entity',
          targetId: target.id,
          expectedVersion: target.updatedAt,
        },
      ],
    );

    const [a, b] = await Promise.all([
      decide(reviewId, 'approve'),
      decide(reviewId, 'approve'),
    ]);
    expect([a, b].filter((r) => r.mutated).length).toBe(1);
    expect(await repository.getEntityById(APP_ID, source.id)).toBeNull();
    expect(await reviewState(reviewId)).toBe('applied');
  });
});
