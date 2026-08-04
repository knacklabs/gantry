import { candidateStatusForChoice, initialProposalStatus, snoozeUntil, } from '../shared/pattern-candidate-policy.js';
/**
 * Host-owned candidate decision service: records a live user choice against a
 * pattern candidate. `create_draft` is the ONLY choice that sets
 * `proposal_requested` (the agent then calls `request_skill_proposal` in
 * conversation). The batch detection pass never reaches this path — that is the
 * invariant: only an explicit live Create draft may start a proposal.
 */
export async function applyPatternCandidateChoice(input) {
    const transition = {
        candidateStatus: candidateStatusForChoice(input.choice),
        proposalStatus: input.choice === 'create_draft' ? initialProposalStatus() : null,
        snoozedUntil: input.choice === 'not_now' ? snoozeUntil(input.nowIso) : null,
    };
    return input.repo.transition({
        id: input.candidateId,
        transition,
        nowIso: input.nowIso,
    });
}
