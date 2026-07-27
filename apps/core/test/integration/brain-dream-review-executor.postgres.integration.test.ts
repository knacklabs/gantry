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
});
