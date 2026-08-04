export declare const HOST_EXECUTION_SLOT_KEY_PREFIX = "host:execution:";
type HostCapacityProcessRole = 'all' | 'control' | 'live-worker' | 'job-worker';
export type HostExecutionRuntimeClass = 'interactive' | 'background';
interface HostCapacityQueueOptions {
    maxMessageRuns?: number;
    maxJobRuns?: number;
}
export interface HostCapacityPlan {
    cpuThreads: number;
    budget: number;
    interactiveCapacity: number;
    backgroundCapacity: number;
}
export declare function detectHostCpuThreads(): number;
export declare function hostExecutionSlotKey(workerInstanceId?: string, runtimeClass?: HostExecutionRuntimeClass): string;
export declare function hostExecutionSlotHolderId(holderId: string): string;
export declare function computeHostCapacityPlan(input: {
    queue: HostCapacityQueueOptions;
    processRole?: HostCapacityProcessRole;
    cpuThreads?: number;
}): HostCapacityPlan;
export declare function applyHostCapacityToQueuePolicy(queue: HostCapacityQueueOptions, processRole?: HostCapacityProcessRole, cpuThreads?: number): HostCapacityQueueOptions;
export {};
