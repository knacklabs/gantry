import { type CanonicalMemoryItemRow } from './app-memory-canonical-codec.js';
import type { MemoryLifecycleProposal, NormalizedMemorySubject } from './memory-types.js';
type ProposalEvidenceRow = {
    id: string;
    text: string;
    metadataJson: string;
};
type ProposalCandidateRow = {
    id: string;
    kind: string;
    key: string;
    value: string;
    reason: string | null;
    confidence: number;
    evidenceIdsJson: string;
    updatedAt: string;
};
export declare function proposeMemoryDreamingActions(input: {
    subject: NormalizedMemorySubject;
    evidence: ProposalEvidenceRow[];
    candidates: ProposalCandidateRow[];
    activeItems: CanonicalMemoryItemRow[];
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<MemoryLifecycleProposal[]>;
export declare function proposeMemoryConsolidationActions(input: {
    subject: NormalizedMemorySubject;
    activeItems: CanonicalMemoryItemRow[];
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<MemoryLifecycleProposal[]>;
export {};
