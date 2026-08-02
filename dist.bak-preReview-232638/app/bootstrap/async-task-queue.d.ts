export declare class AsyncTaskQueue {
    private readonly maxActive;
    private readonly maxPending;
    private activeCount;
    private readonly pending;
    private pendingHead;
    private drainResolvers;
    private slotResolvers;
    private slotResolverHead;
    constructor(maxActive: number, maxPending: number, _maxWaiting?: number);
    enqueue(task: () => Promise<void>): boolean;
    enqueueWhenAvailable(task: () => Promise<void>): Promise<boolean>;
    waitForIdle(timeoutMs?: number): Promise<boolean>;
    size(): number;
    private isIdle;
    private drain;
    private resolveNextSlotWaiterIfAvailable;
    private resolveDrainIfIdle;
    private waitForSlot;
}
