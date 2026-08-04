import type { IpcDeps } from './ipc-domain-types.js';
interface ScheduledInteractionIpcRequest {
    jobId?: string;
    runId?: string;
    targetJid?: string;
    threadId?: string;
}
export declare function validatePermissionIpcJobExecutionTarget(input: {
    request: ScheduledInteractionIpcRequest;
    sourceAgentFolder: string;
    deps: IpcDeps;
}): Promise<void>;
export declare function validateUserQuestionIpcJobExecutionTarget(input: {
    request: ScheduledInteractionIpcRequest;
    sourceAgentFolder: string;
    deps: IpcDeps;
}): Promise<void>;
export {};
