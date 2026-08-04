export type ProactiveSurfacingOutcome = 'surfaced' | 'accepted' | 'dismissed' | 'opted_out' | 'skipped_error' | 'opt_in_unavailable';
export interface ProactiveSurfacingMetricCandidate {
    signature?: string | null;
    status?: string;
}
export interface ProactiveSurfacingMetricPayload {
    subjectHash: string;
    outcome: ProactiveSurfacingOutcome;
    candidateSignature?: string;
}
export declare function outcomeForPatternCandidateStatus(status: string | undefined): ProactiveSurfacingOutcome;
export declare function buildProactiveSurfacingMetricPayloads(input: {
    subjectId: string;
    candidates: ProactiveSurfacingMetricCandidate[];
    outcome: ProactiveSurfacingOutcome;
}): ProactiveSurfacingMetricPayload[];
