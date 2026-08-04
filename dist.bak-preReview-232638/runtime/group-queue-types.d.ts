import type { GroupQueuePolicyOptions } from './group-queue-policy.js';
import type { RunnerControlPort } from './runner-control-port.js';
export type QueueKind = 'message' | 'task';
export type RuntimeAdmissionClass = 'interactive' | 'interactive_child' | 'background' | 'maintenance';
export type TaskAdmissionClass = Exclude<RuntimeAdmissionClass, 'interactive'>;
export type ContinuationOptions = {
    threadId?: string | null;
    senderUserIds?: readonly string[] | null;
};
export type ContinuationHandler = () => void;
export interface GroupMessageRunContext {
    finalRetry: boolean;
}
export type ProcessMessagesFn = (groupJid: string, context: GroupMessageRunContext) => Promise<boolean>;
export type ContinuationRunnerControlPort = Pick<RunnerControlPort, 'writeContinuationInput' | 'writeCloseSignal'>;
export declare const RUNNER_CONTROL_PORT: unique symbol;
export declare const localContinuationRunnerControlPort: ContinuationRunnerControlPort;
export interface QueuedTask {
    id: string;
    kind: QueueKind;
    admissionClass: TaskAdmissionClass;
    groupJid: string;
    fn: () => Promise<void>;
}
export interface GroupStateFields {
    active: boolean;
    idleWaiting: boolean;
    isTaskRun: boolean;
    runningTaskId: string | null;
    pendingMessages: boolean;
    pendingTasks: QueuedTask[];
    runHandle: string | null;
    workspaceFolder: string | null;
    threadId: string | null;
    requiredContinuationUserId: string | null;
    retryCount: number;
    continuationHandler: ContinuationHandler | null;
}
export declare function isGroupStateIdle(state: GroupStateFields & {
    process: unknown;
}): boolean;
export interface GroupQueueOptions extends GroupQueuePolicyOptions {
    setTimeoutFn?: typeof setTimeout;
    runnerControlPort?: ContinuationRunnerControlPort;
}
