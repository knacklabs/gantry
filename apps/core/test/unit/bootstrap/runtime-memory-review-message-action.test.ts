import { beforeEach, describe, expect, it, vi } from 'vitest';

const processMemoryReviewDecisionRequestMock = vi.hoisted(() => vi.fn());
const resolveReviewSubjectWithinBoundaryMock = vi.hoisted(() => vi.fn());
const resolveTrustedMemorySubjectMock = vi.hoisted(() =>
  vi.fn(() => ({
    appId: 'default',
    agentId: 'a',
    subjectType: 'user',
    subjectId: 's',
  })),
);

vi.mock('@core/memory/memory-review-ipc.js', () => ({
  processMemoryReviewDecisionRequest: processMemoryReviewDecisionRequestMock,
  resolveReviewSubjectWithinBoundary: resolveReviewSubjectWithinBoundaryMock,
}));
vi.mock('@core/memory/memory-ipc.js', () => ({
  resolveTrustedMemorySubject: resolveTrustedMemorySubjectMock,
}));

import {
  executeMemoryReviewDecision,
  handleMemoryReviewDecisionAction,
  type MemoryReviewMessageActionDeps,
} from '@core/app/bootstrap/runtime-memory-review-message-action.js';
import type { MemoryReviewMessageActionInput } from '@core/domain/types.js';

function baseAction(
  overrides: Partial<MemoryReviewMessageActionInput> = {},
): MemoryReviewMessageActionInput {
  return {
    kind: 'memory_review_decision',
    conversationJid: 'sl:C123',
    userId: 'U123',
    reviewId: 'rev-1',
    decision: 'approve',
    label: 'Approve',
    ...overrides,
  };
}

function deps(overrides: Partial<MemoryReviewMessageActionDeps> = {}): {
  deps: MemoryReviewMessageActionDeps;
  execute: ReturnType<typeof vi.fn>;
  isControlApproverAllowed: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async () => ({
    state: 'applied' as const,
    receipt: 'Memory review approved.',
  }));
  const isControlApproverAllowed = vi.fn(async () => true);
  return {
    execute,
    isControlApproverAllowed,
    deps: {
      sourceAgentFolderFor: () => 'main_agent',
      isControlApproverAllowed: isControlApproverAllowed as never,
      execute,
      ...overrides,
    },
  };
}

describe('handleMemoryReviewDecisionAction', () => {
  it('executes an authorized approve and returns applied', async () => {
    const { deps: d, execute } = deps();
    const outcome = await handleMemoryReviewDecisionAction(d, baseAction());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      reviewId: 'rev-1',
      decision: 'approve',
      reviewerId: 'U123',
      sourceAgentFolder: 'main_agent',
      conversationJid: 'sl:C123',
    });
    expect(outcome).toEqual({
      state: 'applied',
      receipt: 'Memory review approved.',
    });
  });

  it('maps an authorized reject through to the executor', async () => {
    const execute = vi.fn(async () => ({
      state: 'applied' as const,
      receipt: 'Memory review rejected.',
    }));
    const { deps: d } = deps({ execute });
    const outcome = await handleMemoryReviewDecisionAction(
      d,
      baseAction({ decision: 'reject' }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'reject', reviewerId: 'U123' }),
    );
    expect(outcome.state).toBe('applied');
  });

  it('denies a non-approver without calling the executor', async () => {
    const { deps: d, execute } = deps({
      isControlApproverAllowed: (async () => false) as never,
    });
    const outcome = await handleMemoryReviewDecisionAction(d, baseAction());
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.state).toBe('denied');
  });

  it('rejects a missing provider user id without approver check or execute', async () => {
    const { deps: d, execute, isControlApproverAllowed } = deps();
    const outcome = await handleMemoryReviewDecisionAction(
      d,
      baseAction({ userId: undefined }),
    );
    expect(isControlApproverAllowed).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.state).toBe('invalid');
  });

  it('rejects when the conversation has no single source agent', async () => {
    const { deps: d, execute } = deps({
      sourceAgentFolderFor: () => undefined,
    });
    const outcome = await handleMemoryReviewDecisionAction(d, baseAction());
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.state).toBe('invalid');
  });

  it('maps an unknown/foreign review to invalid', async () => {
    const execute = vi.fn(async () => ({
      state: 'invalid' as const,
      receipt: 'This review could not be found.',
    }));
    const { deps: d } = deps({ execute });
    const outcome = await handleMemoryReviewDecisionAction(d, baseAction());
    expect(outcome.state).toBe('invalid');
  });

  it('maps a no-longer-pending review to stale', async () => {
    const execute = vi.fn(async () => ({
      state: 'stale' as const,
      receipt: 'This review is no longer pending.',
    }));
    const { deps: d } = deps({ execute });
    const outcome = await handleMemoryReviewDecisionAction(d, baseAction());
    expect(outcome.state).toBe('stale');
  });

  it('does not execute an edit; returns needs_input with a reply command', async () => {
    const { deps: d, execute } = deps();
    const outcome = await handleMemoryReviewDecisionAction(
      d,
      baseAction({ decision: 'edit' }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.state).toBe('needs_input');
    expect(outcome.receipt).toContain('edit memory review rev-1');
    expect(outcome.replacementText).toBe('edit memory review rev-1: ');
    expect(outcome.clearActions).toBe(false);
  });
});

describe('executeMemoryReviewDecision', () => {
  beforeEach(() => {
    processMemoryReviewDecisionRequestMock.mockReset();
    resolveReviewSubjectWithinBoundaryMock.mockReset();
  });

  it("uses the review's OWN subject, not the approver, and records channel_action", async () => {
    // Approver U-ADMIN is NOT the review owner U-OWNER (user-scoped memory).
    resolveReviewSubjectWithinBoundaryMock.mockResolvedValueOnce({
      appId: 'default',
      agentId: 'a',
      subjectType: 'user',
      subjectId: 'U-OWNER',
    });
    processMemoryReviewDecisionRequestMock.mockResolvedValueOnce({
      ok: true,
      data: { review: { status: 'applied' } },
    });
    const result = await executeMemoryReviewDecision({
      reviewId: 'rev-1',
      decision: 'approve',
      reviewerId: 'U-ADMIN',
      sourceAgentFolder: 'main_agent',
      conversationJid: 'sl:C123',
    });
    expect(resolveReviewSubjectWithinBoundaryMock).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'a',
      reviewId: 'rev-1',
    });
    expect(processMemoryReviewDecisionRequestMock).toHaveBeenCalledTimes(1);
    const call = processMemoryReviewDecisionRequestMock.mock.calls[0][0];
    // subject is the review's owner, NOT the approver.
    expect(call.subject).toMatchObject({
      subjectType: 'user',
      subjectId: 'U-OWNER',
    });
    expect(call.request.payload).toMatchObject({
      review_id: 'rev-1',
      decision: 'approve',
      decision_source: 'channel_action',
    });
    // approver identity flows through as audit/authorization context only.
    expect(call.request.context).toMatchObject({
      userId: 'U-ADMIN',
      reviewerIsControlApprover: true,
    });
    expect(result).toEqual({
      state: 'applied',
      receipt: 'Memory review approved.',
    });
  });

  it('returns invalid without executing when the review is outside the agent boundary', async () => {
    resolveReviewSubjectWithinBoundaryMock.mockResolvedValueOnce(null);
    const result = await executeMemoryReviewDecision({
      reviewId: 'foreign-rev',
      decision: 'approve',
      reviewerId: 'U123',
      sourceAgentFolder: 'main_agent',
      conversationJid: 'sl:C123',
    });
    expect(processMemoryReviewDecisionRequestMock).not.toHaveBeenCalled();
    expect(result.state).toBe('invalid');
  });

  it('maps a subject-lookup failure to a controlled invalid without executing', async () => {
    resolveReviewSubjectWithinBoundaryMock.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const result = await executeMemoryReviewDecision({
      reviewId: 'rev-1',
      decision: 'approve',
      reviewerId: 'U123',
      sourceAgentFolder: 'main_agent',
      conversationJid: 'sl:C123',
    });
    expect(processMemoryReviewDecisionRequestMock).not.toHaveBeenCalled();
    expect(result.state).toBe('invalid');
  });

  it('maps a lost pending-review claim to stale', async () => {
    resolveReviewSubjectWithinBoundaryMock.mockResolvedValueOnce({
      appId: 'default',
      agentId: 'a',
      subjectType: 'user',
      subjectId: 'U-OWNER',
    });
    processMemoryReviewDecisionRequestMock.mockRejectedValueOnce(
      new Error('pending memory review not found'),
    );
    const result = await executeMemoryReviewDecision({
      reviewId: 'rev-1',
      decision: 'reject',
      reviewerId: 'U123',
      sourceAgentFolder: 'main_agent',
      conversationJid: 'sl:C123',
    });
    expect(result.state).toBe('stale');
  });

  it('maps other executor failures to invalid', async () => {
    resolveReviewSubjectWithinBoundaryMock.mockResolvedValueOnce({
      appId: 'default',
      agentId: 'a',
      subjectType: 'user',
      subjectId: 'U-OWNER',
    });
    processMemoryReviewDecisionRequestMock.mockRejectedValueOnce(
      new Error('memory subsystem unavailable'),
    );
    const result = await executeMemoryReviewDecision({
      reviewId: 'rev-1',
      decision: 'approve',
      reviewerId: 'U123',
      sourceAgentFolder: 'main_agent',
      conversationJid: 'sl:C123',
    });
    expect(result.state).toBe('invalid');
  });
});
