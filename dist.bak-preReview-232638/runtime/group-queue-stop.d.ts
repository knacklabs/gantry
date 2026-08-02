import { ChildProcess } from 'child_process';
import { type ContinuationRunnerControlPort } from './group-queue-types.js';
export declare const ACTIVE_RUN_STOP_REQUESTED: unique symbol;
interface StopActiveGroupRunOptions {
    groupJid: string;
    targetQueueJid: string;
    proc: ChildProcess;
    closeStdin: () => void;
}
export declare function runPort(process: unknown): ContinuationRunnerControlPort | undefined;
export declare function stopActiveGroupRun({ groupJid, targetQueueJid, proc, closeStdin, }: StopActiveGroupRunOptions): boolean;
export declare function activeRunStopWasRequested(proc: ChildProcess): boolean;
export {};
