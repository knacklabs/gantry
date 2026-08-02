import type { LiveAdmissionWorkItem, LiveAdmissionWorkItemEnqueueResult, LiveAdmissionWorkItemRepository } from '../../../../domain/ports/live-turns.js';
import type { CanonicalDb, CanonicalExecutor } from './canonical-graph-repository.postgres.js';
type EnqueueLiveAdmissionWorkItemInput = Parameters<LiveAdmissionWorkItemRepository['enqueueLiveAdmissionWorkItem']>[0];
export declare function enqueueLiveAdmissionWorkItem(db: CanonicalDb, input: EnqueueLiveAdmissionWorkItemInput, maxLiveAdmissionBacklog: number): Promise<LiveAdmissionWorkItemEnqueueResult>;
export declare function enqueueLiveAdmissionWorkItemWithExecutor(db: CanonicalExecutor, input: EnqueueLiveAdmissionWorkItemInput, maxLiveAdmissionBacklog: number): Promise<LiveAdmissionWorkItemEnqueueResult>;
export declare function claimLiveAdmissionWorkItems(db: CanonicalDb, input: {
    appId: string;
    workerInstanceId: string;
    claimToken: string;
    claimExpiresAt: string;
    limit: number;
    now?: string;
}): Promise<LiveAdmissionWorkItem[]>;
export declare function renewLiveAdmissionWorkItemClaim(db: CanonicalDb, input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    claimExpiresAt: string;
    now?: string;
}): Promise<boolean>;
export declare function deferLiveAdmissionWorkItem(db: CanonicalDb, input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    reason: 'queued_capacity' | 'listener_degraded' | 'retry';
    deferUntil: string;
    countFailure?: boolean;
    now?: string;
}): Promise<boolean>;
export declare function settleLiveAdmissionWorkItem(db: CanonicalDb, input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    state: Extract<LiveAdmissionWorkItem['state'], 'completed' | 'failed' | 'canceled'>;
    now?: string;
}): Promise<boolean>;
export {};
