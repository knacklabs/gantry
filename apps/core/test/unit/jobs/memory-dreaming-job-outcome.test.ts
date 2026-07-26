import { describe, expect, it, vi } from 'vitest';

import {
  buildMemoryReviewCreatedNotification,
  createdReviewIdsFromDreamSummary,
} from '@core/jobs/memory-dreaming-job-outcome.js';
import { summarizeDreamDecisions } from '@core/memory/app-memory-service-dreaming.js';
import type { NormalizedMemorySubject } from '@core/memory/memory-types.js';

const subject: NormalizedMemorySubject = {
  appId: 'default',
  agentId: 'agent-1',
  subjectType: 'user',
  subjectId: 'user-1',
} as NormalizedMemorySubject;

describe('createdReviewIdsFromDreamSummary', () => {
  it('reads the ids array structurally from the run summary', () => {
    expect(
      createdReviewIdsFromDreamSummary({ createdReviewIds: ['a', 'b'] }),
    ).toEqual(['a', 'b']);
  });

  it('returns empty for missing/invalid shapes without parsing prose', () => {
    expect(createdReviewIdsFromDreamSummary(undefined)).toEqual([]);
    expect(
      createdReviewIdsFromDreamSummary('4 sent to review: mrv_x.'),
    ).toEqual([]);
    expect(
      createdReviewIdsFromDreamSummary({ createdReviewIds: [1, '', 'ok'] }),
    ).toEqual(['ok']);
  });
});

describe('summarizeDreamDecisions', () => {
  it('carries the created review ids from needs_review decisions', () => {
    const summary = summarizeDreamDecisions(
      [
        { action: 'needs_review', reviewId: 'mrv_1' },
        { action: 'promote' },
        { action: 'needs_review', reviewId: 'mrv_2' },
      ],
      false,
    );
    expect(summary.createdReviewIds).toEqual(['mrv_1', 'mrv_2']);
    expect(summary.needsReview).toBe(2);
  });
});

describe('buildMemoryReviewCreatedNotification', () => {
  function fakeMemory(record: unknown) {
    return {
      getReviewWithinAgentBoundary: vi.fn(async () => record),
    } as never;
  }

  const record = {
    id: 'mrv_1',
    proposal: { action: 'rewrite', key: 'user.location', reason: 'stale' },
    reviewSnapshot: null,
  } as never;

  it('loads the first review and builds a snapshot-sourced view', async () => {
    const memory = fakeMemory(record);
    const context = await buildMemoryReviewCreatedNotification({
      memory,
      subject,
      createdReviewIds: ['mrv_1', 'mrv_2'],
      pendingCount: 2,
    });

    expect(context).not.toBeNull();
    expect(context?.kind).toBe('memory_review_created');
    expect(context?.reviewMessageView.reviewId).toBe('mrv_1');
    expect(context?.reviewMessageView.affordances).toHaveLength(3);
    expect(context?.pendingCount).toBe(2);
    expect(
      (memory as { getReviewWithinAgentBoundary: ReturnType<typeof vi.fn> })
        .getReviewWithinAgentBoundary,
    ).toHaveBeenCalledWith(
      { appId: 'default', agentId: 'agent-1', reviewId: 'mrv_1' },
      expect.objectContaining({ statementTimeoutMs: expect.any(Number) }),
    );
  });

  it('returns null when there are no created ids', async () => {
    const context = await buildMemoryReviewCreatedNotification({
      memory: fakeMemory(record),
      subject,
      createdReviewIds: [],
      pendingCount: 0,
    });
    expect(context).toBeNull();
  });

  it('returns null when the review cannot be loaded', async () => {
    const context = await buildMemoryReviewCreatedNotification({
      memory: fakeMemory(null),
      subject,
      createdReviewIds: ['mrv_gone'],
      pendingCount: 1,
    });
    expect(context).toBeNull();
  });
});
