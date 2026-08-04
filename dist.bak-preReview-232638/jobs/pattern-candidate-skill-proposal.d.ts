import type { PatternCandidateRepository } from '../domain/ports/pattern-candidates.js';
import { type PatternActionKind } from '../shared/pattern-candidate-action-kind.js';
type PatternCandidateLifecycle = Record<string, () => Promise<void>>;
type AcceptPatternCandidateResult = {
    ok: true;
    reviewedTool: string;
    lifecycle?: PatternCandidateLifecycle;
} | {
    ok: false;
    error: string;
    code: string;
};
export declare function candidateBelongsToRequest(input: {
    candidate: Awaited<ReturnType<PatternCandidateRepository['getById']>>;
    appId: string;
    agentId: string;
    targetJid: string;
    memoryUserId?: string;
}): boolean;
export declare function acceptPatternCandidateForAction(input: {
    repo: PatternCandidateRepository;
    candidateId: string;
    appId: string;
    sourceAgentFolder: string;
    targetJid: string;
    memoryUserId?: string;
    actionKind: PatternActionKind;
}): Promise<AcceptPatternCandidateResult>;
export declare function claimPatternCandidateForSkillProposal(input: {
    repo: PatternCandidateRepository;
    candidateId: string;
    appId: string;
    sourceAgentFolder: string;
    targetJid: string;
    memoryUserId?: string;
}): Promise<{
    ok: true;
    reviewedTool: 'request_skill_proposal';
    lifecycle: PatternCandidateLifecycle;
} | {
    ok: false;
    error: string;
    code: string;
}>;
export {};
