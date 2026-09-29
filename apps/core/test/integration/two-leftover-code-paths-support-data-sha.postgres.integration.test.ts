import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { createPendingMemoryReview } from '@core/memory/app-memory-review-create.js';
import { listPendingMemoryReviews } from '@core/memory/app-memory-review.js';
import { buildReviewMessageView } from '@core/memory/review-message-view.js';
import type { NormalizedMemorySubject } from '@core/memory/memory-types.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('memory reviews require stored snapshots (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  const subject: NormalizedMemorySubject = {
    appId: 'default',
    agentId: 'agent-snapshot-contract',
    subjectType: 'user',
    subjectId: 'user-snapshot-contract',
    userId: 'user-snapshot-contract',
  };
  const itemId = 'mem-snapshot-contract';
  const evidenceId = 'mev-snapshot-contract';

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'review_snapshot_contract',
    });
    const now = '2026-09-29T00:00:00.000Z';
    await runtime.service.db.insert(pgSchema.memoryEvidencePostgres).values({
      id: evidenceId,
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      userId: subject.userId ?? null,
      groupId: null,
      channelId: null,
      threadId: null,
      sourceType: 'message',
      sourceId: 'message-snapshot-contract',
      actorId: subject.userId ?? null,
      text: 'The user moved to Berlin.',
      metadataJson: '{}',
      createdAt: now,
    });
    await runtime.service.db.insert(pgSchema.memoryItemsPostgres).values({
      id: itemId,
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      userId: subject.userId ?? null,
      conversationId: null,
      threadId: null,
      kind: 'fact',
      key: 'home_city',
      valueJson: JSON.stringify({ value: 'Paris', why: null }),
      sourceRefJson: JSON.stringify({
        source: 'dreaming',
        subject,
        version: 1,
        evidenceIds: [evidenceId],
      }),
      confidence: 0.8,
      status: 'active',
      lastObservedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('renders the persisted review snapshot after live memory changes', async () => {
    const db = runtime.service.db;
    const created = await createPendingMemoryReview({
      db,
      runId: 'run-snapshot-contract',
      subject,
      phase: 'rem',
      proposal: {
        action: 'rewrite',
        itemId,
        kind: 'fact',
        key: 'home_city',
        value: 'Berlin',
        reason: 'The user moved.',
        confidence: 0.9,
        evidenceIds: [evidenceId],
      },
    });
    expect(created.status).toBe('created');

    await db
      .update(pgSchema.memoryItemsPostgres)
      .set({ valueJson: JSON.stringify({ value: 'Rome', why: null }) })
      .where(eq(pgSchema.memoryItemsPostgres.id, itemId));
    await db
      .update(pgSchema.memoryEvidencePostgres)
      .set({ text: 'The user moved to Rome.' })
      .where(eq(pgSchema.memoryEvidencePostgres.id, evidenceId));

    const reviews = await listPendingMemoryReviews({ db, subject });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reviewSnapshot.conflict?.active.value).toBe('Paris');
    const view = buildReviewMessageView(reviews[0]);
    expect(view.sides[0].value).toBe('Paris');
    expect(view.change).toBe('"Berlin"');
    expect(view.evidence[0].snippet).toBe('The user moved to Berlin.');
  });
});
