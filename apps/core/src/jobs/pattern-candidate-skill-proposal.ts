import type { PatternCandidateRepository } from '../domain/ports/pattern-candidates.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { canonicalConversationIdForMemory } from '../memory/app-memory-subject-resolver.js';
import { applyPatternCandidateChoice } from '../memory/pattern-candidate-decision.js';
import {
  PATTERN_ACTION_KIND_TOOL,
  type PatternActionKind,
} from '../shared/pattern-candidate-action-kind.js';
import { nowIso } from '../shared/time/datetime.js';

type ProposalStatus =
  | 'proposal_pending_review'
  | 'proposal_approved'
  | 'proposal_rejected'
  | 'proposal_blocked';

type PatternCandidateLifecycle = Record<string, () => Promise<void>>;

type AcceptPatternCandidateResult =
  | {
      ok: true;
      reviewedTool: string;
      lifecycle?: PatternCandidateLifecycle;
    }
  | { ok: false; error: string; code: string };

export function candidateBelongsToRequest(input: {
  candidate: Awaited<ReturnType<PatternCandidateRepository['getById']>>;
  appId: string;
  agentId: string;
  targetJid: string;
  memoryUserId?: string;
}): boolean {
  const candidate = input.candidate;
  if (!candidate) return false;
  if (candidate.appId !== input.appId || candidate.agentId !== input.agentId) {
    return false;
  }
  const channelSubjectId = canonicalConversationIdForMemory(input.targetJid);
  return (
    (candidate.subjectType === 'channel' &&
      candidate.subjectId === channelSubjectId) ||
    (candidate.subjectType === 'user' &&
      (candidate.subjectId === input.memoryUserId ||
        candidate.subjectId === input.targetJid)) ||
    candidate.subjectId === input.targetJid
  );
}

export async function acceptPatternCandidateForAction(input: {
  repo: PatternCandidateRepository;
  candidateId: string;
  appId: string;
  sourceAgentFolder: string;
  targetJid: string;
  memoryUserId?: string;
  actionKind: PatternActionKind;
}): Promise<AcceptPatternCandidateResult> {
  const candidate = await input.repo.getById(input.candidateId);
  const agentId = memoryAgentIdForWorkspaceFolder(input.sourceAgentFolder);
  if (
    !candidateBelongsToRequest({
      candidate,
      appId: input.appId,
      agentId,
      targetJid: input.targetJid,
      memoryUserId: input.memoryUserId,
    })
  ) {
    return {
      ok: false,
      error: 'Pattern candidate is not valid for this request.',
      code: 'forbidden',
    };
  }
  const transitioned =
    input.actionKind === 'skill'
      ? await applyPatternCandidateChoice({
          repo: input.repo,
          candidateId: input.candidateId,
          choice: 'create_draft',
          nowIso: nowIso(),
        })
      : await input.repo.transition({
          id: input.candidateId,
          transition: {
            candidateStatus: 'accepted',
            proposalStatus: null,
            snoozedUntil: null,
          },
          nowIso: nowIso(),
        });
  if (!transitioned) {
    return {
      ok: false,
      error: 'Pattern candidate is no longer available for this request.',
      code: 'invalid_state',
    };
  }
  const reviewedTool = PATTERN_ACTION_KIND_TOOL[input.actionKind];
  if (input.actionKind !== 'skill') {
    return {
      ok: true,
      reviewedTool,
    };
  }
  const setStatus = (proposalStatus: ProposalStatus) =>
    input.repo.setProposalStatus({
      id: input.candidateId,
      proposalStatus,
      nowIso: nowIso(),
    });
  return {
    ok: true,
    reviewedTool,
    lifecycle: {
      onReviewStarted: async () =>
        void (await setStatus('proposal_pending_review')),
      onApproved: async () => void (await setStatus('proposal_approved')),
      onRejected: async () => void (await setStatus('proposal_rejected')),
      onBlocked: async () => void (await setStatus('proposal_blocked')),
    },
  };
}

export async function claimPatternCandidateForSkillProposal(input: {
  repo: PatternCandidateRepository;
  candidateId: string;
  appId: string;
  sourceAgentFolder: string;
  targetJid: string;
  memoryUserId?: string;
}): Promise<
  | {
      ok: true;
      reviewedTool: 'request_skill_proposal';
      lifecycle: PatternCandidateLifecycle;
    }
  | { ok: false; error: string; code: string }
> {
  const result = await acceptPatternCandidateForAction({
    ...input,
    actionKind: 'skill',
  });
  if (!result.ok) return result;
  return {
    ok: true,
    reviewedTool: 'request_skill_proposal',
    lifecycle: result.lifecycle as PatternCandidateLifecycle,
  };
}
