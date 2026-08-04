import type { MemoryIpcRequest, MemoryIpcResponse } from '@gantry/contracts';
import type { NormalizedMemorySubject } from './memory-types.js';
interface TrustedMemoryContext {
    userId?: string;
    reviewerIsControlApprover?: boolean;
}
type MemoryReviewTrustedRequest = Omit<MemoryIpcRequest, 'context'> & {
    context?: TrustedMemoryContext;
    deadlineAtMs?: number;
};
export declare function processPendingMemoryReviewRequest(input: {
    request: MemoryReviewTrustedRequest;
    subject: NormalizedMemorySubject;
}): Promise<MemoryIpcResponse>;
export declare function processMemoryReviewDecisionRequest(input: {
    request: MemoryReviewTrustedRequest;
    subject: NormalizedMemorySubject;
}): Promise<MemoryIpcResponse>;
export {};
