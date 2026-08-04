type MaintenanceTask = () => Promise<void>;
interface MemoryMaintenanceQueueOptions {
    maxPending?: number;
    onError?: (workspaceFolder: string, err: unknown) => void;
}
export interface MemoryMaintenanceQueueEnqueueResult {
    queued: boolean;
    deduped: boolean;
    reason: 'queued' | 'deduped' | 'full' | 'invalid';
}
export declare class MemoryMaintenanceQueue {
    private readonly maxPending;
    private readonly onError;
    private running;
    private readonly pending;
    private readonly inflight;
    private readonly inflightGroups;
    constructor(options?: MemoryMaintenanceQueueOptions);
    enqueue(workspaceFolder: string, task: MaintenanceTask, dedupeKey?: string): boolean;
    enqueueDetailed(workspaceFolder: string, task: MaintenanceTask, dedupeKey?: string): MemoryMaintenanceQueueEnqueueResult;
    enqueueAndWait(workspaceFolder: string, task: MaintenanceTask, dedupeKey?: string, options?: {
        signal?: AbortSignal;
    }): Promise<MemoryMaintenanceQueueEnqueueResult>;
    getPendingCount(): number;
    isRunningForGroup(workspaceFolder: string): boolean;
    private enqueueInternal;
    private removePending;
    private pump;
}
export declare function getMemoryMaintenanceQueue(): MemoryMaintenanceQueue;
export {};
