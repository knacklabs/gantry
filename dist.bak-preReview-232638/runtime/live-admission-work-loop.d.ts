import type { LiveAdmissionWorkItemRepository } from '../domain/ports/live-turns.js';
import { type MessageLoopDeps } from './message-loop.js';
type WarnLog = (context: Record<string, unknown>, message: string) => void;
export interface LiveAdmissionWorkLoopHandle {
    /** Stop the loop after the in-flight item, releasing the rest of the claim batch. */
    stop: (options?: {
        drainDeadlineMs?: number;
    }) => Promise<void>;
    /** Wake the loop early; LISTEN/NOTIFY callers use this as a hint only. */
    trigger: () => void;
    /** Settles when the loop exits. */
    done: Promise<void>;
}
export interface StartLiveAdmissionWorkLoopInput {
    liveAdmissions: LiveAdmissionWorkItemRepository;
    appId: string;
    workerInstanceId: string;
    messageLoopDeps: MessageLoopDeps;
    claimLimit?: number;
    claimTtlMs?: number;
    claimRenewalIntervalMs?: number;
    intervalMs?: number;
    maxBatchesPerWake?: number;
    maxRetryCount?: number;
    warn: WarnLog;
}
export declare function startLiveAdmissionWorkLoop(input: StartLiveAdmissionWorkLoopInput): LiveAdmissionWorkLoopHandle;
export {};
