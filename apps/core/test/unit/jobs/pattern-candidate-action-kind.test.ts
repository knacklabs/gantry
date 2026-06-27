import type {
  PatternCandidate,
  PatternProposalStatus,
} from '@gantry/contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  PatternCandidateRepository,
  PatternCandidateTransition,
} from '@core/domain/ports/pattern-candidates.js';
import {
  acceptPatternCandidateForAction,
  claimPatternCandidateForSkillProposal,
} from '@core/jobs/pattern-candidate-skill-proposal.js';
import {
  isPatternActionKind,
  PATTERN_ACTION_KIND_TOOL,
  type PatternActionKind,
} from '@core/shared/pattern-candidate-action-kind.js';

const ACTION_KINDS: PatternActionKind[] = [
  'scheduler_job',
  'durable_capability',
  'skill',
  'memory_update',
];

function candidate(
  overrides: Partial<PatternCandidate> = {},
): PatternCandidate {
  return {
    id: 'pc_1',
    appId: 'app',
    agentId: 'agent:work',
    folder: 'work',
    subjectType: 'user',
    subjectId: 'u1',
    signature: 'sig',
    outcomeLabel: 'RUN_ME_LITERAL_CANDIDATE_TEXT',
    shortAsk: 'repeat the thing',
    occurrences: 4,
    windowStart: '2026-01-01T00:00:00.000Z',
    windowEnd: '2026-01-31T00:00:00.000Z',
    lastDetectedAt: '2026-01-31T00:00:00.000Z',
    candidateStatus: 'suggested',
    proposalStatus: null,
    snoozedUntil: null,
    evidenceRefs: [],
    createdAt: '2026-01-31T00:00:00.000Z',
    updatedAt: '2026-01-31T00:00:00.000Z',
    ...overrides,
  };
}

function candidateWithUnreadOutcome() {
  const next = candidate();
  const outcomeLabel = vi.fn(() => {
    throw new Error('candidate outcome text should not be executed or read');
  });
  Object.defineProperty(next, 'outcomeLabel', {
    get: outcomeLabel,
  });
  return { candidate: next, outcomeLabel };
}

function repoFor(existing: PatternCandidate) {
  const getById = vi.fn(async () => existing);
  const transition = vi.fn(
    async (input: {
      id: string;
      transition: PatternCandidateTransition;
      nowIso: string;
    }) =>
      candidate({
        id: input.id,
        candidateStatus: input.transition.candidateStatus,
        proposalStatus: input.transition.proposalStatus ?? null,
        snoozedUntil: input.transition.snoozedUntil ?? null,
      }),
  );
  const setProposalStatus = vi.fn(
    async (_input: {
      id: string;
      proposalStatus: PatternProposalStatus;
      nowIso: string;
    }) => null,
  );
  const repo: PatternCandidateRepository = {
    listEligible: vi.fn(async () => []),
    getById,
    transition,
    setProposalStatus,
  };
  return { repo, getById, transition, setProposalStatus };
}

describe('PatternActionKind', () => {
  it('recognizes only supported action kinds', () => {
    for (const kind of ACTION_KINDS) {
      expect(isPatternActionKind(kind)).toBe(true);
    }
    expect(isPatternActionKind('request_skill_proposal')).toBe(false);
    expect(isPatternActionKind(null)).toBe(false);
  });
});

describe('acceptPatternCandidateForAction', () => {
  it.each(ACTION_KINDS)(
    'accepts %s through only its reviewed tool marker',
    async (actionKind) => {
      const unread = candidateWithUnreadOutcome();
      const { repo, getById, transition, setProposalStatus } = repoFor(
        unread.candidate,
      );

      const result = await acceptPatternCandidateForAction({
        repo,
        candidateId: 'pc_1',
        appId: 'app',
        sourceAgentFolder: 'work',
        targetJid: 'u1',
        actionKind,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.reviewedTool).toBe(PATTERN_ACTION_KIND_TOOL[actionKind]);
      expect(JSON.stringify(result)).not.toContain(
        'RUN_ME_LITERAL_CANDIDATE_TEXT',
      );
      expect(unread.outcomeLabel).not.toHaveBeenCalled();
      expect(getById).toHaveBeenCalledWith('pc_1');
      expect(transition).toHaveBeenCalledTimes(1);
      expect(setProposalStatus).not.toHaveBeenCalled();
      expect(transition.mock.calls[0]?.[0]).toMatchObject({
        id: 'pc_1',
        transition: {
          candidateStatus: 'accepted',
          proposalStatus: actionKind === 'skill' ? 'proposal_requested' : null,
          snoozedUntil: null,
        },
      });
      if (actionKind === 'skill') {
        expect(result.lifecycle).toEqual({
          onReviewStarted: expect.any(Function),
          onApproved: expect.any(Function),
          onRejected: expect.any(Function),
          onBlocked: expect.any(Function),
        });
      } else {
        expect(result.lifecycle).toBeUndefined();
      }
    },
  );

  it('rejects a candidate outside the signed app and agent scope', async () => {
    const { repo, transition, setProposalStatus } = repoFor(
      candidate({ appId: 'other-app' }),
    );

    const result = await acceptPatternCandidateForAction({
      repo,
      candidateId: 'pc_1',
      appId: 'app',
      sourceAgentFolder: 'work',
      targetJid: 'u1',
      actionKind: 'skill',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Pattern candidate is not valid for this request.',
      code: 'forbidden',
    });
    expect(transition).not.toHaveBeenCalled();
    expect(setProposalStatus).not.toHaveBeenCalled();
  });

  it('keeps claimPatternCandidateForSkillProposal on the skill lifecycle path', async () => {
    const { repo, transition, setProposalStatus } = repoFor(candidate());

    const result = await claimPatternCandidateForSkillProposal({
      repo,
      candidateId: 'pc_1',
      appId: 'app',
      sourceAgentFolder: 'work',
      targetJid: 'u1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.reviewedTool).toBe('request_skill_proposal');
    expect(result.lifecycle).toEqual({
      onReviewStarted: expect.any(Function),
      onApproved: expect.any(Function),
      onRejected: expect.any(Function),
      onBlocked: expect.any(Function),
    });
    expect(transition.mock.calls[0]?.[0].transition).toMatchObject({
      candidateStatus: 'accepted',
      proposalStatus: 'proposal_requested',
      snoozedUntil: null,
    });

    await result.lifecycle.onApproved();
    expect(setProposalStatus).toHaveBeenCalledWith({
      id: 'pc_1',
      proposalStatus: 'proposal_approved',
      nowIso: expect.any(String),
    });
  });
});
