import type { PatternCandidate } from '@gantry/contracts';
import { type PatternSubjectScope } from './pattern-candidate-subject.js';
/**
 * Formats the "patterns I've noticed" block injected next to durable memory in
 * the per-run context. It rides the existing memory trust boundary (delivered as
 * untrusted data, not authority), and the wording here reinforces that: the
 * agent raises at most one with the user, proposes outcome-first, and never acts
 * on a pattern alone.
 */
export declare const PATTERN_BLOCK_OPEN = "[[PATTERNS_NOTICED]]";
export declare const PATTERN_BLOCK_CLOSE = "[[/PATTERNS_NOTICED]]";
export declare function formatPatternsBlock(candidates: PatternCandidate[]): string;
export interface PatternsContext {
    block: string;
    surfacedCandidateIds: string[];
}
/** Minimal structural view of the candidate repo (avoids a domain import here). */
interface EligibleCandidateReader {
    listEligible(input: {
        subject: {
            appId: string;
            agentId: string;
            folder: string;
            subjectType: string;
            subjectId: string;
        };
        limit: number;
    }): Promise<PatternCandidate[]>;
    transition?(input: {
        id: string;
        transition: {
            candidateStatus: 'suggested';
            proposalStatus?: null;
            snoozedUntil?: null;
        };
        nowIso: string;
    }): Promise<PatternCandidate | null>;
}
/**
 * Read-only, guarded loader used by the runner: fetches the single top eligible
 * candidate for the user-scoped subject and formats the block. Returns '' when
 * there is no repo, no user scope, or on any fetch error (never breaks a run).
 * The subject scope must match the dreaming detection pass; confirm in live
 * verification.
 */
export declare function loadPatternsContextBlock(repo: EligibleCandidateReader | undefined, scope: PatternSubjectScope): Promise<string>;
export declare function loadPatternsContext(repo: EligibleCandidateReader | undefined, scope: PatternSubjectScope): Promise<PatternsContext>;
export declare function markPatternsContextSurfaced(repo: EligibleCandidateReader | undefined, candidateIds: string[]): Promise<void>;
export {};
