import type { MemoryKind, MemoryScope, NormalizedMemorySubject } from './memory-types.js';
export interface StructuredDreamCandidate {
    kind: Extract<MemoryKind, 'preference' | 'decision' | 'fact' | 'correction' | 'constraint'>;
    scope: MemoryScope;
    key: string;
    value: string;
    why: string;
    confidence: number;
    operation: 'promote' | 'retire';
    retireKey?: string;
}
type MemoryEvidenceRow = {
    metadataJson: string | null;
};
type MemoryCandidateRow = {
    kind: string;
    key: string;
    value: string;
    reason: string | null;
    confidence: number;
    evidenceIdsJson: string | null;
    metadataJson: string | null;
};
type MemoryItemRow = {
    valueJson: unknown;
};
export declare function parseStructuredEvidenceCandidate(evidence: MemoryEvidenceRow, subject: NormalizedMemorySubject): {
    candidate?: StructuredDreamCandidate;
    rejection?: string;
};
export declare function parseStagedCandidateMetadata(candidate: MemoryCandidateRow): {
    operation: 'promote' | 'retire';
    retireKey?: string;
};
export declare function validatePromotableCandidate(candidate: MemoryCandidateRow): {
    ok: boolean;
    rationale: string;
    needsReview?: boolean;
};
export declare function extractMemoryValue(row: MemoryItemRow): string;
export {};
