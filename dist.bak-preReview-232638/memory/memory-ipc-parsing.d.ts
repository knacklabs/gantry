import { MemoryReviewDecision, MemoryReviewPageContext, PatchMemoryInput, PatchProcedureInput, SaveMemoryInput, SaveProcedureInput } from './memory-types.js';
export type ParsedReviewDecisionRequest = {
    kind: 'single';
    reviewId: string;
    decision: MemoryReviewDecision;
    editedValue?: string;
    editedReason?: string;
} | {
    kind: 'batch';
    pageContext: MemoryReviewPageContext;
    decisions: ParsedReviewBatchDecision[];
};
export interface ParsedReviewBatchDecision {
    number?: number;
    reviewId?: string;
    decision: MemoryReviewDecision;
    editedValue?: string;
    editedReason?: string;
}
export declare function parseOptionalString(value: unknown, opts?: {
    maxLen?: number;
}): string | undefined;
export declare function parseOptionalNumber(value: unknown, opts?: {
    min?: number;
    max?: number;
}): number | undefined;
export declare function parseSaveMemoryInput(payload: unknown): SaveMemoryInput;
export declare function parsePatchMemoryInput(payload: unknown): PatchMemoryInput;
export declare function parseDemoteMemoryInput(payload: unknown): {
    id: string;
    expectedVersion?: number;
    reason?: string;
};
export declare function parseReviewDecisionRequest(payload: unknown): ParsedReviewDecisionRequest;
export declare function parseSaveProcedureInput(payload: unknown): SaveProcedureInput;
export declare function parsePatchProcedureInput(payload: unknown): PatchProcedureInput;
