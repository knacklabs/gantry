import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { createPendingMemoryReview } from '@core/memory/app-memory-review-create.js';
import type { NormalizedMemorySubject } from '@core/memory/memory-types.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const subject: NormalizedMemorySubject = {
  appId: 'default',
  agentId: 'agent-dedupe',
  groupId: 'group-dedupe',
  subjectType: 'group',
  subjectId: 'group-dedupe',
};

const ITEM_ID = 'mem-dedupe-1';
const EVIDENCE_ID = 'mev-dedupe-1';
const ORIGINAL_VALUE =
  'Actually use the lead finder job for hourly prospecting instead of the cleanup mode.';
const CHANGED_VALUE =
  'Use two named modes: lead finder for hourly prospecting and cleanup for weekly archiving.';

function proposalFor(value: string) {
  return {
    action: 'needs_review' as const,
    itemId: ITEM_ID,
    key: 'decision:job-naming',
    value,
    reason: 'REM dreaming found correction language.',
    confidence: 0.9,
    evidenceIds: [EVIDENCE_ID],
  };
}

maybeDescribe('memory review dedupe (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'memory_review_dedupe',
    });
    const now = '2026-07-08T00:00:00.000Z';
    await runtime.service.db.insert(pgSchema.memoryEvidencePostgres).values({
      id: EVIDENCE_ID,
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      userId: null,
      groupId: subject.groupId ?? null,
      channelId: null,
      threadId: null,
      sourceType: 'session',
      sourceId: 'session-dedupe',
      actorId: 'user-dedupe',
      text: `${ORIGINAL_VALUE} ${CHANGED_VALUE}`,
      metadataJson: '{}',
      createdAt: now,
    });
    await runtime.service.db.insert(pgSchema.memoryItemsPostgres).values({
      id: ITEM_ID,
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      userId: null,
      conversationId: null,
      threadId: null,
      kind: 'decision',
      key: 'decision:job-naming',
      valueJson: JSON.stringify({ value: ORIGINAL_VALUE, why: null }),
      sourceRefJson: JSON.stringify({
        source: 'dreaming',
        subject,
        version: 1,
        evidenceIds: [EVIDENCE_ID],
      }),
      confidence: 0.8,
      status: 'active',
      lastObservedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('creates once, absorbs repeats, and never re-opens adjudicated content', async () => {
    const db = runtime.service.db;

    const first = await createPendingMemoryReview({
      db,
      runId: 'mdr-night-1',
      subject,
      phase: 'rem',
      proposal: proposalFor(ORIGINAL_VALUE),
    });
    expect(first.status).toBe('created');
    expect(first.reviewId).toMatch(/^mrv_/);

    // Same content re-detected while the review is still pending: absorbed.
    const second = await createPendingMemoryReview({
      db,
      runId: 'mdr-night-2',
      subject,
      phase: 'rem',
      proposal: proposalFor(ORIGINAL_VALUE),
    });
    expect(second).toMatchObject({
      status: 'pending_exists',
      reviewId: first.reviewId,
    });

    // A human decides the review (approve-as-is / reject — any terminal
    // decision), without changing the memory text.
    await db
      .update(pgSchema.memoryReviewRequestsPostgres)
      .set({
        status: 'rejected',
        decision: 'reject',
        decidedAt: '2026-07-08T01:00:00.000Z',
        updatedAt: '2026-07-08T01:00:00.000Z',
      })
      .where(eq(pgSchema.memoryReviewRequestsPostgres.id, first.reviewId));

    // The exact loop from production: next nightly pass re-detects the same
    // correction language. It must NOT open a new review.
    const third = await createPendingMemoryReview({
      db,
      runId: 'mdr-night-3',
      subject,
      phase: 'rem',
      proposal: proposalFor(ORIGINAL_VALUE),
    });
    expect(third).toMatchObject({
      status: 'adjudicated',
      reviewId: first.reviewId,
    });

    const rows = await db
      .select({ id: pgSchema.memoryReviewRequestsPostgres.id })
      .from(pgSchema.memoryReviewRequestsPostgres)
      .where(
        eq(pgSchema.memoryReviewRequestsPostgres.agentId, subject.agentId),
      );
    expect(rows).toHaveLength(1);

    // Changed content is a new fingerprint and legitimately reviews again.
    await db
      .update(pgSchema.memoryItemsPostgres)
      .set({
        valueJson: JSON.stringify({ value: CHANGED_VALUE, why: null }),
        updatedAt: '2026-07-08T02:00:00.000Z',
      })
      .where(eq(pgSchema.memoryItemsPostgres.id, ITEM_ID));

    const fourth = await createPendingMemoryReview({
      db,
      runId: 'mdr-night-4',
      subject,
      phase: 'rem',
      proposal: proposalFor(CHANGED_VALUE),
    });
    expect(fourth.status).toBe('created');
    expect(fourth.reviewId).not.toBe(first.reviewId);
  });
});
