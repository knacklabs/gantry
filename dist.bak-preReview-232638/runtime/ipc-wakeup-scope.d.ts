import type { IpcRequestWakeupHint } from './ipc-request-wakeup-registry.js';
import type { RunnerControlRequestLane } from './runner-control-port.js';
type IpcProcessScope = 'all' | 'hinted';
export interface IpcWakeupProcessPlan {
    scope: IpcProcessScope;
    shouldProcessRequestLane(sourceAgentFolder: string, lane: RunnerControlRequestLane): boolean;
}
export declare class IpcWakeupScopeTracker {
    private nextProcessScope;
    private processAgainScope;
    private readonly pendingWakeHints;
    scheduleFullScan(): void;
    recordWakeup(hint?: IpcRequestWakeupHint): void;
    recordWakeupDuringPass(hint?: IpcRequestWakeupHint): void;
    startPass(): IpcWakeupProcessPlan;
    scheduleFollowupPass(): void;
    clearFollowupPass(): void;
    private addWakeHint;
}
export {};
