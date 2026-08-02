import type { Job } from '../domain/types.js';
import { setObserverDigestGateway } from './observer-digest-job.js';
import type { SchedulerDependencies } from './types.js';
export { MEMORY_DREAM_SYSTEM_PROMPT, MEMORY_EMBEDDING_BACKFILL_SYSTEM_PROMPT, BRAIN_EMBEDDING_BACKFILL_SYSTEM_PROMPT, BRAIN_DREAM_SYSTEM_PROMPT, } from '../shared/system-job-identity.js';
export { setObserverDigestGateway };
export declare function memoryDreamingTimeoutForJob(jobTimeoutMs: number | null | undefined): number;
export declare function registerSystemJobs(deps: SchedulerDependencies): Promise<void>;
export declare function handleSystemJob(job: Job, context: {
    folder: string;
    conversationId?: string;
    conversationKind?: 'dm' | 'channel';
    userId?: string;
    threadId?: string | null;
}, options?: {
    signal?: AbortSignal;
    deadlineAtMs?: number;
}): Promise<string>;
export declare function resetSystemJobStateForTests(): void;
export declare function _setMemoryMaintenanceQueueForTests(queue: unknown): void;
