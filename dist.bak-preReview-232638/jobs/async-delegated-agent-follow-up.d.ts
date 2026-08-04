import type { RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
import { type AsyncTaskRecord, type AsyncTaskRepository } from '../domain/ports/async-tasks.js';
export type CallableAgentFollowUpMessageRepository = Pick<RuntimeMessageRepository, 'storeMessageWithLiveAdmission'>;
export declare function isCallableAgentDelegatedTask(task: AsyncTaskRecord): boolean;
export declare function hasPendingCallableAgentFollowUp(task: AsyncTaskRecord): boolean;
export declare function hasDeliveredCallableAgentFollowUp(task: AsyncTaskRecord): boolean;
export declare function markCallableAgentAsyncFallback(input: {
    repository: AsyncTaskRepository;
    task: AsyncTaskRecord;
}): Promise<AsyncTaskRecord>;
export declare function deliverPendingCallableAgentFollowUp(input: {
    task: AsyncTaskRecord;
    repository: AsyncTaskRepository;
    messageRepository?: CallableAgentFollowUpMessageRepository;
}): Promise<boolean>;
export declare function callableAgentFollowUpText(task: AsyncTaskRecord): string;
