import type { PatternCandidate } from '@gantry/contracts';
import type { PatternCandidateRepository } from '../domain/ports/pattern-candidates.js';
import { type PatternCandidateChoice } from '../shared/pattern-candidate-policy.js';
/**
 * Host-owned candidate decision service: records a live user choice against a
 * pattern candidate. `create_draft` is the ONLY choice that sets
 * `proposal_requested` (the agent then calls `request_skill_proposal` in
 * conversation). The batch detection pass never reaches this path — that is the
 * invariant: only an explicit live Create draft may start a proposal.
 */
export declare function applyPatternCandidateChoice(input: {
    repo: PatternCandidateRepository;
    candidateId: string;
    choice: PatternCandidateChoice;
    nowIso: string;
}): Promise<PatternCandidate | null>;
