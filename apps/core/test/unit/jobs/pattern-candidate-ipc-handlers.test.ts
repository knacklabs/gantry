import { createHash } from 'node:crypto';

import type { PatternCandidate } from '@gantry/contracts';
import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type {
  PatternCandidateRepository,
  PatternCandidateTransition,
} from '@core/domain/ports/pattern-candidates.js';
import {
  configurePatternCandidateIpcHandlers,
  patternCandidateDecisionHandler,
} from '@core/jobs/pattern-candidate-ipc-handlers.js';
import type { PatternActionKind } from '@core/shared/pattern-candidate-action-kind.js';

const NON_SKILL_ACTION_KINDS: PatternActionKind[] = [
  'scheduler_job',
  'durable_capability',
  'memory_update',
];

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

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
    signature: 'sig_accepted',
    outcomeLabel: 'repeat the weekly report',
    shortAsk: 'weekly report',
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
  const repo: PatternCandidateRepository = {
    listEligible: vi.fn(async () => []),
    getById,
    transition,
    setProposalStatus: vi.fn(async () => null),
  };
  return { repo, transition };
}

describe('patternCandidateDecisionHandler', () => {
  it.each(NON_SKILL_ACTION_KINDS)(
    'accepts %s and records the accepted proactive metric',
    async (actionKind) => {
      const { repo, transition } = repoFor(candidate());
      const publishRuntimeEvent = vi.fn(async () => undefined);
      configurePatternCandidateIpcHandlers({
        getStorage: () => ({ repositories: { patternCandidates: repo } }),
      });

      await patternCandidateDecisionHandler({
        data: {
          type: 'pattern_candidate_decision',
          appId: 'app',
          chatJid: 'u1',
          targetJid: 'u1',
          authThreadId: 'thread-1',
          runId: 'run-1',
          payload: {
            patternCandidateId: 'pc_1',
            choice: 'accept',
            actionKind,
          },
        },
        sourceAgentFolder: 'work',
        deps: { publishRuntimeEvent } as never,
        conversationBindings: {},
        sourceAgentFolderJids: ['u1'],
      });

      expect(transition).toHaveBeenCalledWith({
        id: 'pc_1',
        transition: {
          candidateStatus: 'accepted',
          proposalStatus: null,
          snoozedUntil: null,
        },
        nowIso: expect.any(String),
      });
      expect(publishRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app',
          agentId: 'agent:work',
          runId: 'run-1',
          conversationId: 'u1',
          threadId: 'thread-1',
          eventType: RUNTIME_EVENT_TYPES.PROACTIVE_SURFACING_OUTCOME,
          actor: 'runtime',
          responseMode: 'none',
          payload: {
            subjectHash: sha256Hex('u1'),
            outcome: 'accepted',
            candidateSignature: 'sig_accepted',
          },
        }),
      );
    },
  );

  it('does not accept skill decisions outside request_skill_proposal', async () => {
    const { repo, transition } = repoFor(candidate());
    const publishRuntimeEvent = vi.fn(async () => undefined);
    configurePatternCandidateIpcHandlers({
      getStorage: () => ({ repositories: { patternCandidates: repo } }),
    });

    await patternCandidateDecisionHandler({
      data: {
        type: 'pattern_candidate_decision',
        appId: 'app',
        chatJid: 'u1',
        targetJid: 'u1',
        payload: {
          patternCandidateId: 'pc_1',
          choice: 'accept',
          actionKind: 'skill',
        },
      },
      sourceAgentFolder: 'work',
      deps: { publishRuntimeEvent } as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['u1'],
    });

    expect(transition).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).not.toHaveBeenCalled();
  });
});
