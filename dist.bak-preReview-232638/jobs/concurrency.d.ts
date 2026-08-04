import type { RunSlotRepository } from '../domain/ports/worker-coordination.js';
interface RunSlotBackend {
    repository: RunSlotRepository;
    workerInstanceId: string;
    warn?: (context: Record<string, unknown>, message: string) => void;
}
export declare function configureRunSlotBackend(next: RunSlotBackend | null): void;
export declare function acquireRunSlot(workspaceKey: string, maxParallelRuns?: number, options?: {
    hostCapacity?: number;
    hostBudgetCapacity?: number;
    runId?: string | null;
    onSlotLost?: () => void;
}): Promise<() => void>;
export declare function tryAcquireRunSlot(workspaceKey: string, maxParallelRuns?: number, options?: {
    hostCapacity?: number;
    hostBudgetCapacity?: number;
    runId?: string | null;
    onSlotLost?: () => void;
}): Promise<(() => void) | null>;
export declare function resetSchedulerRunSlots(): void;
export {};
