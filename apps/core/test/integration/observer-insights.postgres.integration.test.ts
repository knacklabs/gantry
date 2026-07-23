import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresBrainRepository } from '@core/adapters/storage/postgres/repositories/brain-repository.postgres.js';
import { PostgresEmbeddingCacheStore } from '@core/memory/memory-embedding-cache-store.js';
import type { ObserverInsightCreate } from '@core/domain/ports/observer-insights.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'observer-persistence-app';
const SUBJECT = 'conversation:sl:C111' as const;
const OTHER_SUBJECT = 'conversation:sl:C222' as const;
const NOW = '2026-07-22T08:00:00.000Z';

function insight(
  id: string,
  overrides: Partial<ObserverInsightCreate> = {},
): ObserverInsightCreate {
  return {
    id,
    appId: APP_ID,
    subject: SUBJECT,
    insightType: 'commitment',
    title: `Insight ${id}`,
    summary: `Summary ${id}`,
    evidenceRefs: [
      {
        conversationId: SUBJECT,
        messageId: id,
        ts: '2026-07-22T07:54:00.000Z',
      },
    ],
    batchSnapshotAt: '2026-07-22T07:55:00.000Z',
    evidenceVersion: 1,
    canonicalSignature: `signature:${id}`,
    confidence: 0.8,
    priorityScore: 0.5,
    recipient: 'owner:user-1',
    nowIso: NOW,
    ...overrides,
  };
}

maybeDescribe('observer insight Postgres persistence', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'observer_insights',
    });
    await runtime.repositories.apps.saveApp({
      id: APP_ID as never,
      slug: APP_ID,
      name: 'Observer persistence test',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('applies the insight, delivery-ledger, and cursor migration contract', async () => {
    const columns = await runtime.service.pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name IN (
           'proactive_insights',
           'observer_deliveries',
           'observer_insight_cursors'
         )
       ORDER BY table_name, ordinal_position`,
      [runtime.schemaName],
    );
    const columnsFor = (table: string) =>
      columns.rows
        .filter((row) => row.table_name === table)
        .map((row) => row.column_name);

    expect(columnsFor('proactive_insights')).toEqual([
      'id',
      'app_id',
      'subject',
      'insight_type',
      'title',
      'summary',
      'evidence_refs',
      'batch_snapshot_at',
      'evidence_version',
      'canonical_signature',
      'signature_embedding_ref',
      'confidence',
      'priority_score',
      'state',
      'cooldown_until',
      'resolved_at',
      'surfaced_at',
      'recipient',
      'delivery_id',
      'created_at',
      'updated_at',
    ]);
    expect(columnsFor('observer_deliveries')).toEqual([
      'id',
      'app_id',
      'recipient',
      'local_day',
      'created_at',
    ]);
    expect(columnsFor('observer_insight_cursors')).toEqual([
      'app_id',
      'subject',
      'cursor_updated_at',
      'cursor_page_id',
      'updated_at',
    ]);

    const constraints = await runtime.service.pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = $1::regnamespace
         AND conrelid IN (
           'proactive_insights'::regclass,
           'observer_insight_cursors'::regclass
         )`,
      [runtime.schemaName],
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        'proactive_insights_insight_type_check',
        'proactive_insights_state_check',
        'proactive_insights_evidence_version_check',
        'proactive_insights_confidence_check',
        'observer_insight_cursors_complete_cursor_check',
      ]),
    );

    const indexes = await runtime.service.pool.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = $1
         AND tablename IN ('proactive_insights', 'observer_deliveries')`,
      [runtime.schemaName],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'idx_proactive_insights_queue',
        'idx_proactive_insights_app_signature',
        'observer_deliveries_app_recipient_day_unique',
      ]),
    );
    expect(
      indexes.rows.find(
        (row) => row.indexname === 'idx_proactive_insights_app_signature',
      )?.indexdef,
    ).toMatch(
      /CREATE UNIQUE INDEX.*WHERE .*state.*pending.*claimed.*sent.*cooldown/,
    );
  });

  it('persists, orders, finds, counts, and enforces insight lifecycle transitions', async () => {
    const repo = runtime.repositories.observerInsights;
    const low = await repo.create(insight('low', { priorityScore: 0.2 }));
    const high = await repo.create(
      insight('high', {
        priorityScore: 0.9,
        nowIso: '2026-07-22T08:01:00.000Z',
      }),
    );
    await repo.create(
      insight('other-subject', {
        subject: OTHER_SUBJECT,
        priorityScore: 1,
        nowIso: '2026-07-22T08:02:00.000Z',
      }),
    );

    expect(low).toMatchObject({
      id: 'low',
      state: 'pending',
      evidenceRefs: [
        {
          conversationId: SUBJECT,
          messageId: 'low',
          ts: '2026-07-22T07:54:00.000Z',
        },
      ],
      signatureEmbeddingRef: null,
      deliveryId: null,
    });
    expect(
      (
        await repo.listPendingForSubject({
          appId: APP_ID,
          subject: SUBJECT,
          limit: 10,
        })
      ).map((row) => row.id),
    ).toEqual(['high', 'low']);
    expect(await repo.count({ appId: APP_ID })).toBe(3);
    expect(await repo.count({ appId: APP_ID, subject: SUBJECT })).toBe(2);
    expect(
      await repo.findBySignature({
        appId: APP_ID,
        subject: SUBJECT,
        canonicalSignature: high.canonicalSignature,
      }),
    ).toMatchObject({ id: 'high' });
    const firstPage = await repo.list({ appId: APP_ID, limit: 2 });
    expect(firstPage.map((row) => row.id)).toEqual(['other-subject', 'high']);
    expect(
      (
        await repo.list({
          appId: APP_ID,
          limit: 2,
          before: {
            createdAt: firstPage[1]!.createdAt,
            id: firstPage[1]!.id,
          },
        })
      ).map((row) => row.id),
    ).toEqual(['low']);
    await expect(
      repo.create(insight('invalid-subject', { subject: 'owner-1' as never })),
    ).rejects.toThrow(
      'Observer insight subject must be a valid observer subject key',
    );

    await expect(
      repo.transitionState({
        id: high.id,
        from: 'pending',
        to: 'sent',
        nowIso: NOW,
      }),
    ).rejects.toThrow('Invalid observer insight transition: pending -> sent');
    const highClaim = await repo.transitionState({
      id: high.id,
      from: 'pending',
      to: 'claimed',
      nowIso: NOW,
    });
    expect(highClaim).toMatchObject({ state: 'claimed' });
    if (!highClaim) throw new Error('high insight was not claimed');

    const wrongDelivery = await repo.recordDelivery({
      id: 'delivery-wrong-recipient',
      appId: APP_ID,
      recipient: 'owner:someone-else',
      localDay: '2026-07-22',
      nowIso: NOW,
    });
    await expect(
      repo.markDelivered({
        id: high.id,
        deliveryId: wrongDelivery.id,
        claimedAt: highClaim.updatedAt,
        surfacedAt: NOW,
        nowIso: NOW,
      }),
    ).rejects.toThrow(
      'Observer delivery must match the claimed insight app and recipient',
    );

    const delivery = await repo.recordDelivery({
      id: 'delivery-1',
      appId: APP_ID,
      recipient: high.recipient,
      localDay: '2026-07-22',
      nowIso: NOW,
    });
    await expect(
      repo.markDelivered({
        id: high.id,
        deliveryId: delivery.id,
        claimedAt: highClaim.updatedAt,
        surfacedAt: NOW,
        nowIso: NOW,
      }),
    ).resolves.toMatchObject({
      state: 'sent',
      deliveryId: delivery.id,
      surfacedAt: NOW,
    });
    await expect(
      repo.transitionState({
        id: high.id,
        from: 'sent',
        to: 'cooldown',
        cooldownUntil: '2026-07-29T08:00:00.000Z',
        nowIso: NOW,
      }),
    ).resolves.toMatchObject({ state: 'cooldown' });
    await expect(
      repo.transitionState({
        id: high.id,
        from: 'cooldown',
        to: 'resolved',
        resolvedAt: NOW,
        nowIso: NOW,
      }),
    ).resolves.toMatchObject({ state: 'resolved', resolvedAt: NOW });
    await expect(
      repo.transitionState({
        id: high.id,
        from: 'resolved',
        to: 'pending',
        nowIso: NOW,
      }),
    ).rejects.toThrow(
      'Invalid observer insight transition: resolved -> pending',
    );
    const lowClaim = await repo.transitionState({
      id: low.id,
      from: 'pending',
      to: 'claimed',
      nowIso: '2026-07-22T08:02:00.000Z',
    });
    expect(lowClaim).toMatchObject({ state: 'claimed' });
    if (!lowClaim) throw new Error('low insight was not claimed');
    await expect(
      repo.transitionState({
        id: low.id,
        from: 'claimed',
        to: 'sent',
        nowIso: NOW,
      }),
    ).rejects.toThrow('Invalid observer insight transition: claimed -> sent');
    await expect(
      repo.recoverStaleClaims({
        appId: APP_ID,
        subject: SUBJECT,
        staleBeforeIso: lowClaim.updatedAt,
        nowIso: '2026-07-22T08:05:00.000Z',
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: low.id, state: 'pending' }),
    ]);
    const reclaimed = await repo.transitionState({
      id: low.id,
      from: 'pending',
      to: 'claimed',
      nowIso: '2026-07-22T08:06:00.000Z',
    });
    expect(reclaimed).toMatchObject({ state: 'claimed' });
    if (!reclaimed) throw new Error('low insight was not reclaimed');
    await expect(
      repo.markDelivered({
        id: low.id,
        deliveryId: delivery.id,
        claimedAt: lowClaim.updatedAt,
        surfacedAt: NOW,
        nowIso: NOW,
      }),
    ).resolves.toBeNull();
    const lowDelivery = await repo.recordDelivery({
      id: 'delivery-2',
      appId: APP_ID,
      recipient: low.recipient,
      localDay: '2026-07-23',
      nowIso: NOW,
    });
    await expect(
      repo.markDelivered({
        id: low.id,
        deliveryId: lowDelivery.id,
        claimedAt: reclaimed.updatedAt,
        surfacedAt: NOW,
        nowIso: NOW,
      }),
    ).resolves.toMatchObject({ state: 'sent' });
    await expect(
      repo.transitionState({
        id: low.id,
        from: 'sent',
        to: 'cooldown',
        cooldownUntil: '2026-07-29T08:00:00.000Z',
        nowIso: NOW,
      }),
    ).resolves.toMatchObject({ state: 'cooldown' });
    await expect(
      repo.transitionState({
        id: low.id,
        from: 'cooldown',
        to: 'dropped',
        nowIso: NOW,
      }),
    ).resolves.toMatchObject({ state: 'dropped' });
    const freshness = await repo.create(
      insight('freshness-requeue', {
        nowIso: '2026-07-22T08:30:00.000Z',
      }),
    );
    const firstFreshnessClaim = await repo.transitionState({
      id: freshness.id,
      from: 'pending',
      to: 'claimed',
      nowIso: freshness.updatedAt,
    });
    if (!firstFreshnessClaim) throw new Error('freshness claim failed');
    await expect(
      repo.recoverStaleClaims({
        appId: APP_ID,
        subject: SUBJECT,
        staleBeforeIso: firstFreshnessClaim.updatedAt,
        nowIso: '2026-07-22T08:31:00.000Z',
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: freshness.id, state: 'pending' }),
    ]);
    const secondFreshnessClaim = await repo.transitionState({
      id: freshness.id,
      from: 'pending',
      to: 'claimed',
      nowIso: '2026-07-22T08:32:00.000Z',
    });
    if (!secondFreshnessClaim) throw new Error('freshness reclaim failed');
    await expect(
      repo.transitionState({
        id: freshness.id,
        from: 'claimed',
        to: 'dropped',
        claimedAt: firstFreshnessClaim.updatedAt,
        nowIso: '2026-07-22T08:33:00.000Z',
      }),
    ).resolves.toBeNull();
    await expect(
      repo.transitionState({
        id: freshness.id,
        from: 'claimed',
        to: 'pending',
        claimedAt: secondFreshnessClaim.updatedAt,
        nowIso: '2026-07-22T08:34:00.000Z',
      }),
    ).resolves.toMatchObject({ state: 'pending' });
    await expect(
      repo.transitionState({
        id: freshness.id,
        from: 'pending',
        to: 'dropped',
        nowIso: '2026-07-22T08:35:00.000Z',
      }),
    ).resolves.toMatchObject({ state: 'dropped' });
    await expect(
      repo.create(
        insight('high-recurrence', {
          canonicalSignature: high.canonicalSignature,
          nowIso: '2026-07-22T09:00:00.000Z',
        }),
      ),
    ).resolves.toMatchObject({
      id: 'high-recurrence',
      canonicalSignature: high.canonicalSignature,
      state: 'pending',
    });
  });

  it('enforces active signature dedup atomically', async () => {
    const repo = runtime.repositories.observerInsights;
    const canonicalSignature = 'signature:concurrent';
    const results = await Promise.allSettled([
      repo.create(
        insight('concurrent-a', {
          canonicalSignature,
          nowIso: '2026-07-22T09:00:00.000Z',
        }),
      ),
      repo.create(
        insight('concurrent-b', {
          canonicalSignature,
          nowIso: '2026-07-22T09:00:00.000Z',
        }),
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await repo.findBySignature({
        appId: APP_ID,
        subject: SUBJECT,
        canonicalSignature,
      }),
    ).toMatchObject({ canonicalSignature, state: 'pending' });
  });

  it('returns the active signature match when a newer terminal row exists', async () => {
    const repo = runtime.repositories.observerInsights;
    const canonicalSignature = 'signature:active-after-terminal';
    const terminal = await repo.create(
      insight('newer-terminal', {
        canonicalSignature,
        nowIso: '2026-07-22T11:00:00.000Z',
      }),
    );
    await repo.transitionState({
      id: terminal.id,
      from: 'pending',
      to: 'dropped',
      nowIso: '2026-07-22T11:01:00.000Z',
    });
    const activeBackfill = await repo.create(
      insight('older-active-backfill', {
        canonicalSignature,
        nowIso: '2026-07-22T10:00:00.000Z',
      }),
    );

    await expect(
      repo.findBySignature({
        appId: APP_ID,
        subject: SUBJECT,
        canonicalSignature,
      }),
    ).resolves.toMatchObject({
      id: activeBackfill.id,
      state: 'pending',
    });
  });

  it('filters by type and scopes exact signatures to the source conversation', async () => {
    const repo = runtime.repositories.observerInsights;
    const created = await repo.create(
      insight('typed-contradiction', {
        insightType: 'contradiction',
        canonicalSignature: 'signature:typed-contradiction',
      }),
    );

    await expect(
      repo.list({
        appId: APP_ID,
        insightType: 'contradiction',
        limit: 10,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: created.id })]);
    await expect(
      repo.count({ appId: APP_ID, insightType: 'contradiction' }),
    ).resolves.toBe(1);
    await expect(
      repo.findBySignature({
        appId: APP_ID,
        subject: OTHER_SUBJECT,
        canonicalSignature: created.canonicalSignature,
      }),
    ).resolves.toBeNull();
  });

  it('finds active semantic duplicates at the 0.86 same-subject boundary', async () => {
    const repo = runtime.repositories.observerInsights;
    const cache = new PostgresEmbeddingCacheStore(runtime.service.db);
    const model = 'observer-semantic-test';
    const dimensions = 1536;
    const embeddingRef = 'observer-semantic-existing';
    const existingEmbedding = Array<number>(dimensions).fill(0);
    existingEmbedding[0] = 1;
    await cache.putCachedEmbedding(
      embeddingRef,
      model,
      dimensions,
      existingEmbedding,
    );
    const existing = await repo.create(
      insight('semantic-existing', {
        canonicalSignature: 'signature:semantic-existing',
        signatureEmbeddingRef: embeddingRef,
      }),
    );

    const atBoundary = Array<number>(dimensions).fill(0);
    atBoundary[0] = 0.86;
    atBoundary[1] = Math.sqrt(1 - 0.86 ** 2);
    await expect(
      repo.findSemanticDuplicate({
        appId: APP_ID,
        subject: SUBJECT,
        model,
        dimensions,
        embedding: atBoundary,
        minSimilarity: 0.86,
      }),
    ).resolves.toEqual({
      insight: expect.objectContaining({ id: existing.id }),
      similarity: expect.closeTo(0.86, 5),
    });

    const belowBoundary = Array<number>(dimensions).fill(0);
    belowBoundary[0] = 0.859;
    belowBoundary[1] = Math.sqrt(1 - 0.859 ** 2);
    await expect(
      repo.findSemanticDuplicate({
        appId: APP_ID,
        subject: SUBJECT,
        model,
        dimensions,
        embedding: belowBoundary,
        minSimilarity: 0.86,
      }),
    ).resolves.toBeNull();
    await expect(
      repo.findSemanticDuplicate({
        appId: APP_ID,
        subject: OTHER_SUBJECT,
        model,
        dimensions,
        embedding: existingEmbedding,
        minSimilarity: 0.86,
      }),
    ).resolves.toBeNull();
  });

  it('rejects a second delivery for the same app, recipient, and local day', async () => {
    const repo = runtime.repositories.observerInsights;
    await repo.recordDelivery({
      id: 'delivery-first',
      appId: APP_ID,
      recipient: 'owner:duplicate-test',
      localDay: '2026-07-23',
      nowIso: NOW,
    });
    await expect(
      repo.recordDelivery({
        id: 'delivery-duplicate',
        appId: APP_ID,
        recipient: 'owner:duplicate-test',
        localDay: '2026-07-23',
        nowIso: NOW,
      }),
    ).rejects.toThrow();

    const rows = await runtime.service.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM observer_deliveries
       WHERE app_id = $1 AND recipient = $2 AND local_day = $3`,
      [APP_ID, 'owner:duplicate-test', '2026-07-23'],
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it('keeps the per-subject insight cursor independent of the brain cursor', async () => {
    const observerRepo = runtime.repositories.observerInsights;
    const brainRepo = new PostgresBrainRepository(runtime.service.db);
    const brainCursor = {
      updatedAt: '2026-07-20 00:00:00+00',
      pageId: 'brain-page-1',
    };
    const insightCursor = {
      updatedAt: '2026-07-21T00:00:00.000Z',
      pageId: 'insight-page-1',
    };
    const advancedCursor = {
      updatedAt: '2026-07-22T00:00:00.000Z',
      pageId: 'insight-page-2',
    };

    await brainRepo.saveDreamCursor(APP_ID, brainCursor);
    await expect(
      observerRepo.saveInsightCursor(APP_ID, SUBJECT, insightCursor, null, NOW),
    ).resolves.toBe(true);
    await expect(
      observerRepo.saveInsightCursor(
        APP_ID,
        SUBJECT,
        advancedCursor,
        null,
        NOW,
      ),
    ).resolves.toBe(false);

    expect(await brainRepo.getDreamCursor(APP_ID)).toEqual(brainCursor);
    expect(await observerRepo.getInsightCursor(APP_ID, SUBJECT)).toEqual(
      insightCursor,
    );
    expect(
      await observerRepo.getInsightCursor(APP_ID, OTHER_SUBJECT),
    ).toBeNull();

    await expect(
      observerRepo.saveInsightCursor(
        APP_ID,
        SUBJECT,
        advancedCursor,
        insightCursor,
        NOW,
      ),
    ).resolves.toBe(true);
    await expect(
      observerRepo.saveInsightCursor(
        APP_ID,
        SUBJECT,
        {
          updatedAt: '2026-07-23T00:00:00.000Z',
          pageId: 'stale-worker-page',
        },
        insightCursor,
        NOW,
      ),
    ).resolves.toBe(false);
    await expect(
      observerRepo.saveInsightCursor(
        APP_ID,
        SUBJECT,
        insightCursor,
        advancedCursor,
        NOW,
      ),
    ).resolves.toBe(false);
    expect(await observerRepo.getInsightCursor(APP_ID, SUBJECT)).toEqual(
      advancedCursor,
    );
    expect(await brainRepo.getDreamCursor(APP_ID)).toEqual(brainCursor);
  });
});
