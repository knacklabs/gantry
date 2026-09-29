import { describe, expect, it, vi } from 'vitest';

const processDecision = vi.hoisted(() => vi.fn());

vi.mock('@core/memory/memory-review-ipc.js', () => ({
  processMemoryReviewDecisionRequest: processDecision,
  resolveReviewSubjectWithinBoundary: async () => ({
    appId: 'default',
    agentId: 'agent:main_agent',
    subjectType: 'user',
    subjectId: 'memory-owner',
  }),
}));

import { executeMemoryReviewDecision } from '@core/app/bootstrap/runtime-memory-review-message-action.js';

const input = {
  reviewId: 'review-1',
  decision: 'approve' as const,
  reviewerId: 'reviewer-1',
  appId: 'default',
  sourceAgentFolder: 'main_agent',
  conversationJid: 'sl:C123',
};

describe('learned memory review card reply', () => {
  it('reports a failed approval with the actual reason', async () => {
    processDecision.mockResolvedValueOnce({
      ok: true,
      data: {
        review: {
          status: 'failed',
          applyOutcome: 'proposal target memory item version is stale',
        },
      },
    });

    expect(await executeMemoryReviewDecision(input)).toEqual({
      state: 'invalid',
      receipt:
        'Memory review failed: proposal target memory item version is stale',
    });
  });

  it('reports a review that was already decided', async () => {
    processDecision.mockRejectedValueOnce(
      new Error('pending memory review not found'),
    );

    expect(await executeMemoryReviewDecision(input)).toEqual({
      state: 'stale',
      receipt: 'This review was already decided.',
    });
  });
});
