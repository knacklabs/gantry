import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresBrainRepository } from '@core/adapters/storage/postgres/repositories/brain-repository.postgres.js';
import { PostgresBrainDreamReviewRepository } from '@core/adapters/storage/postgres/repositories/brain-dream-review-repository.postgres.js';
import { applyBrainDreamOperations } from '@core/brain/brain-dreaming.js';
import { BrainService } from '@core/brain/brain-service.js';
import type { BrainEntity, BrainPage } from '@core/brain/brain-types.js';
import { normalizeEntityName } from '@core/brain/brain-page-ingest.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'brain-intake-app';
const NOW = '2026-07-27T09:00:00.000Z';

maybeDescribe('brain dream destructive-op review intake', () => {
  let runtime: PostgresIntegrationRuntime;
  let repository: PostgresBrainRepository;
  let reviews: PostgresBrainDreamReviewRepository;
  let brain: BrainService;

  let delPage: BrainPage;
  let mergePage: BrainPage;
  let entA: BrainEntity;
  let entB: BrainEntity;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'brain_intake',
    });
    await runtime.repositories.apps.saveApp({
      id: APP_ID as never,
      slug: APP_ID,
      name: 'Brain intake test',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository = new PostgresBrainRepository(runtime.service.db);
    reviews = new PostgresBrainDreamReviewRepository(runtime.service.db);
    brain = new BrainService(repository);

    const delRes = await repository.upsertPage({
      appId: APP_ID,
      slug: 'delete-me',
      title: 'Delete me',
      markdown: 'body',
      sourceKind: 'user',
    });
    delPage = delRes.page;
    mergePage = (
      await repository.upsertPage({
        appId: APP_ID,
        slug: 'merge-evidence',
        title: 'Merge evidence',
        markdown: 'body',
        sourceKind: 'user',
      })
    ).page;
    const entities = await repository.upsertEntities(APP_ID, [
      {
        kind: 'person',
        name: 'Alice',
        normalizedName: normalizeEntityName('Alice'),
      },
      {
        kind: 'person',
        name: 'Alicia',
        normalizedName: normalizeEntityName('Alicia'),
      },
    ]);
    [entA, entB] = entities;
    // An edge on delPage so the delete_page snapshot has a dependent.
    await repository.upsertEdges(APP_ID, delPage.id, [
      { type: 'mentions', fromEntityId: entA.id, toEntityId: entB.id },
    ]);
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  async function run(op: Record<string, unknown>) {
    return applyBrainDreamOperations({
      brain,
      repository,
      reviews,
      appId: APP_ID,
      runId: 'intake-run',
      page: delPage,
      evidencePages: [delPage],
      ops: [op],
    });
  }

  async function targetsFor(reviewId: string) {
    const rows = await runtime.service.pool.query<{
      target_kind: string;
      target_id: string;
      expected_version: string;
      open: boolean;
    }>(
      `SELECT target_kind, target_id, expected_version, open
       FROM ${runtime.schemaName}.brain_dream_review_targets
       WHERE review_id = $1
       ORDER BY target_id`,
      [reviewId],
    );
    return rows.rows;
  }

  it('creates a review with one target (expected_version = updated_at) + frozen snapshot', async () => {
    const summary = await run({ action: 'delete_page', page_id: delPage.id });
    expect(summary).toMatchObject({ proposed: 1, rejected: 0 });

    const pending = await reviews.listPendingBrainDreamReviews({
      appId: APP_ID,
      limit: 10,
    });
    const review = pending.find((r) => r.action === 'delete_page');
    expect(review).toBeDefined();
    expect(review!.canonicalOp).toEqual({
      action: 'delete_page',
      version: 1,
      pageId: delPage.id,
    });

    const targets = await targetsFor(review!.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      target_kind: 'page',
      target_id: delPage.id,
      expected_version: delPage.updatedAt,
      open: true,
    });

    // Frozen snapshot: page before + the dependent edge.
    const snap = review!.reviewSnapshot as {
      before: { id: string };
      dependents: { edges: unknown[] };
    };
    expect(snap.before.id).toBe(delPage.id);
    expect(snap.dependents.edges).toHaveLength(1);

    // The decision row is linked and journaled proposed.
    const decision = await runtime.service.pool.query<{ outcome: string }>(
      `SELECT outcome FROM ${runtime.schemaName}.brain_dream_decisions WHERE id = $1`,
      [review!.decisionId],
    );
    expect(decision.rows[0]?.outcome).toBe('proposed');
  });

  it('rejects an op whose target does not exist (no review created)', async () => {
    const before = (
      await reviews.listPendingBrainDreamReviews({ appId: APP_ID, limit: 50 })
    ).length;
    const summary = await run({ action: 'delete_page', page_id: 'ghost-page' });
    expect(summary).toMatchObject({ proposed: 0, rejected: 1 });
    const after = await reviews.listPendingBrainDreamReviews({
      appId: APP_ID,
      limit: 50,
    });
    expect(after.length).toBe(before);
  });

  it('rejects an op whose target is already claimed by an open review (target_open)', async () => {
    // delPage is still owned by the first test's review.
    const summary = await run({ action: 'delete_page', page_id: delPage.id });
    expect(summary).toMatchObject({ proposed: 0, rejected: 1 });
  });

  it('creates TWO entity targets for merge_entities', async () => {
    const summary = await applyBrainDreamOperations({
      brain,
      repository,
      reviews,
      appId: APP_ID,
      runId: 'intake-run',
      page: mergePage,
      evidencePages: [mergePage],
      ops: [
        {
          action: 'merge_entities',
          source_entity_id: entA.id,
          target_entity_id: entB.id,
        },
      ],
    });
    expect(summary).toMatchObject({ proposed: 1, rejected: 0 });

    const review = (
      await reviews.listPendingBrainDreamReviews({ appId: APP_ID, limit: 50 })
    ).find((r) => r.action === 'merge_entities');
    expect(review).toBeDefined();
    const targets = await targetsFor(review!.id);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.target_kind)).toEqual(['entity', 'entity']);
    expect(new Set(targets.map((t) => t.target_id))).toEqual(
      new Set([entA.id, entB.id]),
    );
    expect(targets.map((t) => t.expected_version).sort()).toEqual(
      [entA.updatedAt, entB.updatedAt].sort(),
    );
  });

  it('defers retire_page: journaled proposed, no review', async () => {
    const summary = await run({ action: 'retire_page', page_id: delPage.id });
    expect(summary).toMatchObject({ proposed: 1, rejected: 0 });
    const review = (
      await reviews.listPendingBrainDreamReviews({ appId: APP_ID, limit: 50 })
    ).find((r) => r.action === 'retire_page');
    expect(review).toBeUndefined();
    const deferred = await runtime.service.pool.query<{ reason: string }>(
      `SELECT reason FROM ${runtime.schemaName}.brain_dream_decisions
       WHERE app_id = $1 AND (op_json->>'action') = 'retire_page'
       ORDER BY created_at DESC LIMIT 1`,
      [APP_ID],
    );
    expect(deferred.rows[0]?.reason).toContain('deferred');
  });
});
