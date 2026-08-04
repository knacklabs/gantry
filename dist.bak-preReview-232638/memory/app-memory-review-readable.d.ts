import type { MemoryReviewDisplayPage, MemoryReviewEvidenceSnippet, MemoryLifecycleProposal, MemoryReviewReadableItem, MemoryReviewRecord, NormalizedMemorySubject } from './memory-types.js';
interface MemoryItemValueRow {
    id: string;
    kind: string;
    key: string;
    valueJson: unknown;
}
interface MemoryEvidenceSnippetRow {
    id: string;
    sourceType: string;
    sourceId?: string | null;
    text: string;
    createdAt: string;
}
export declare function normalizePendingReviewLimit(value: number | undefined): number;
export declare function normalizePendingReviewOffset(value: number | undefined): number;
export declare function reviewItemIds(proposal: MemoryLifecycleProposal): string[];
export declare function reviewEvidenceIds(reviews: Pick<MemoryReviewRecord, 'proposal'>[]): string[];
export declare function toReadableReviewItem(row: MemoryItemValueRow): MemoryReviewReadableItem;
export declare function toMemoryReviewEvidenceSnippet(row: MemoryEvidenceSnippetRow): MemoryReviewEvidenceSnippet;
export declare function withProposedChanges(reviews: MemoryReviewRecord[], itemsById: Map<string, MemoryReviewReadableItem>): MemoryReviewRecord[];
export declare function toMemoryReviewDisplayPage(input: {
    reviews: MemoryReviewRecord[];
    subject: NormalizedMemorySubject;
    totalCount: number;
    returnedCount: number;
    remainingCount: number;
    limit: number;
    offset: number;
    nextOffset: number | null;
    evidenceById?: Map<string, MemoryReviewEvidenceSnippet>;
}): MemoryReviewDisplayPage;
export {};
