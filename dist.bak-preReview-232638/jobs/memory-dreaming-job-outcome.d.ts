import type { MemoryMaintenanceQueueEnqueueResult } from '../memory/maintenance-queue.js';
import type { DreamingRunStatus, NormalizedMemorySubject } from '../memory/memory-types.js';
import { AppMemoryService } from '../memory/app-memory-service.js';
export declare function countPendingReviewsForNotification(input: {
    memory: AppMemoryService;
    subject: NormalizedMemorySubject;
}): Promise<number>;
export declare function appendPendingReviewContextToError(error: unknown, pendingReviews: number): Error;
export declare function formatMemoryDreamingOutcome(run: DreamingRunStatus | undefined, queueResult: MemoryMaintenanceQueueEnqueueResult): string;
