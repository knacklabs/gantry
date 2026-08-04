import type { PatternCandidate, PatternProposalStatus } from '@gantry/contracts';
import type { PatternCandidateRepository, PatternCandidateSubject, PatternCandidateTransition } from '../../../../domain/ports/pattern-candidates.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
/**
 * Reader for the runner + decision writer for the candidate decision service.
 * The detector/upsert writer (the dreaming pass) writes via direct db + schema
 * in the memory layer, so it is intentionally not implemented here.
 */
export declare class PostgresPatternCandidateRepository implements PatternCandidateRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    listEligible(input: {
        subject: PatternCandidateSubject;
        limit: number;
    }): Promise<PatternCandidate[]>;
    listEligibleForApp(input: {
        appId: string;
        limit: number;
    }): Promise<PatternCandidate[]>;
    getById(id: string): Promise<PatternCandidate | null>;
    transition(input: {
        id: string;
        transition: PatternCandidateTransition;
        nowIso: string;
    }): Promise<PatternCandidate | null>;
    setProposalStatus(input: {
        id: string;
        proposalStatus: PatternProposalStatus;
        nowIso: string;
    }): Promise<PatternCandidate | null>;
}
