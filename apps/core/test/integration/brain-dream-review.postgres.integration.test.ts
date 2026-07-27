import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { brainDreamDecisionsPostgres } from '@core/adapters/storage/postgres/schema/schema.js';
import type { BrainDreamReviewCreateInput } from '@core/brain/brain-dream-review-repository.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'brain-review-app';
const RUN_ID = 'brain-review-run';
const NOW = '2026-07-27T08:00:00.000Z';

function review(
  id: string,
  decisionId: string,
  targets: BrainDreamReviewCreateInput['targets'],
): BrainDreamReviewCreateInput {
  return {
    id,
    appId: APP_ID,
    runId: RUN_ID,
    decisionId,
    action: 'delete_page',
    canonicalOp: { action: 'delete_page', pageId: 'P1' },
    reviewSnapshot: { before: { title: 'Page 1' }, dependents: [] },
    nowIso: NOW,
    targets,
  };
}

maybeDescribe('brain dream review Postgres persistence', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'brain_dream_review',
    });
    await runtime.repositories.apps.saveApp({
      id: APP_ID as never,
      slug: APP_ID,
      name: 'Brain review persistence test',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Reviews FK brain_dream_decisions(decision_id); seed the provenance rows.
    await runtime.service.db.insert(brainDreamDecisionsPostgres).values(
      ['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => ({
        id,
        appId: APP_ID,
        runId: RUN_ID,
        pageId: null,
        opJson: { action: 'delete_page', pageId: 'P1' },
        outcome: 'proposed',
        reason: 'destructive proposal awaiting review',
        createdAt: NOW,
        updatedAt: NOW,
      })),
    );
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  const repo = () => runtime.repositories.brainDreamReviews;

  it('applies the review + target migration contract', async () => {
    const columns = await runtime.service.pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name IN ('brain_dream_reviews', 'brain_dream_review_targets')
       ORDER BY table_name, ordinal_position`,
      [runtime.schemaName],
    );
    const columnsFor = (table: string) =>
      columns.rows
        .filter((row) => row.table_name === table)
        .map((row) => row.column_name);
    expect(columnsFor('brain_dream_reviews')).toEqual(
      expect.arrayContaining([
        'id',
        'app_id',
        'decision_id',
        'action',
        'canonical_op_json',
        'review_snapshot_json',
        'state',
        'decided_at',
        'outcome',
        'error',
      ]),
    );
    expect(columnsFor('brain_dream_review_targets')).toEqual(
      expect.arrayContaining([
        'id',
        'review_id',
        'app_id',
        'target_kind',
        'target_id',
        'expected_version',
        'open',
      ]),
    );
  });

  it('creates a review and its open target claims in one txn', async () => {
    const result = await repo().createBrainDreamReview(
      review('r1', 'd1', [
        { targetKind: 'page', targetId: 'P1', expectedVersion: 'v1' },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.review.state).toBe('pending_review');

    const found = await repo().findPendingBrainDreamReview({
      appId: APP_ID,
      reviewId: 'r1',
    });
    expect(found?.id).toBe('r1');
    expect(found?.canonicalOp).toEqual({ action: 'delete_page', pageId: 'P1' });

    const pending = await repo().listPendingBrainDreamReviews({
      appId: APP_ID,
      limit: 10,
    });
    expect(pending.map((r) => r.id)).toEqual(['r1']);
  });

  it('surfaces an overlapping open target as a typed conflict (not thrown)', async () => {
    const result = await repo().createBrainDreamReview(
      review('r2', 'd2', [
        // P1 is still owned by r1 (open); E1 is free.
        { targetKind: 'page', targetId: 'P1', expectedVersion: 'v1' },
        { targetKind: 'edge', targetId: 'E1', expectedVersion: 'v1' },
      ]),
    );
    expect(result).toEqual({ ok: false, conflict: 'target_open' });

    // Rolled back: r2 did not persist, and E1 was not claimed.
    expect(
      await repo().findPendingBrainDreamReview({
        appId: APP_ID,
        reviewId: 'r2',
      }),
    ).toBeNull();
    const pending = await repo().listPendingBrainDreamReviews({
      appId: APP_ID,
      limit: 10,
    });
    expect(pending.map((r) => r.id)).toEqual(['r1']);
  });

  it('claims a conditional transition at-most-once', async () => {
    const first = await repo().claimBrainDreamReviewTransition({
      reviewId: 'r1',
      from: 'pending_review',
      to: 'applying',
      nowIso: NOW,
    });
    expect(first).toEqual({ claimed: true });

    // Second claim from the now-changed state loses.
    const second = await repo().claimBrainDreamReviewTransition({
      reviewId: 'r1',
      from: 'pending_review',
      to: 'applying',
      nowIso: NOW,
    });
    expect(second).toEqual({ claimed: false });
  });

  it('closes open targets on a terminal transition, freeing them', async () => {
    const terminal = await repo().claimBrainDreamReviewTransition({
      reviewId: 'r1',
      from: 'applying',
      to: 'applied',
      nowIso: NOW,
      outcome: 'page deleted',
    });
    expect(terminal).toEqual({ claimed: true });

    // r1 no longer owns P1, so a fresh review can claim it.
    const reclaim = await repo().createBrainDreamReview(
      review('r3', 'd3', [
        { targetKind: 'page', targetId: 'P1', expectedVersion: 'v2' },
      ]),
    );
    expect(reclaim.ok).toBe(true);

    // r1 fell out of the pending set; r3 is the only pending review now.
    const pending = await repo().listPendingBrainDreamReviews({
      appId: APP_ID,
      limit: 10,
    });
    expect(pending.map((r) => r.id)).toEqual(['r3']);
  });

  it('dedups a redundantly-listed target; a separate review still conflicts', async () => {
    const dup = await repo().createBrainDreamReview({
      ...review('r4', 'd4', [
        { targetKind: 'entity', targetId: 'ENT9', expectedVersion: 'v1' },
        { targetKind: 'entity', targetId: 'ENT9', expectedVersion: 'v1' },
      ]),
    });
    expect(dup.ok).toBe(true);

    // Exactly one target row persisted for the distinct (kind, id).
    const rows = await runtime.service.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${runtime.schemaName}.brain_dream_review_targets
       WHERE review_id = $1 AND target_kind = 'entity' AND target_id = 'ENT9'`,
      ['r4'],
    );
    expect(rows.rows[0]?.count).toBe('1');

    // A separate review on that same target still hits the open claim.
    const conflict = await repo().createBrainDreamReview(
      review('r5', 'd5', [
        { targetKind: 'entity', targetId: 'ENT9', expectedVersion: 'v1' },
      ]),
    );
    expect(conflict).toEqual({ ok: false, conflict: 'target_open' });
  });
});
