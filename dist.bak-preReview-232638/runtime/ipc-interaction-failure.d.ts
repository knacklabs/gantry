import type { IpcInteractionLogger } from './ipc-interaction-processing.js';
export declare function writePermissionInteractionFailure(input: {
    ipcBaseDir: string;
    sourceAgentFolder: string;
    requestId: string;
    responseNonce?: string;
    threadId?: string;
    responseKeyId?: string;
    reason?: string;
    logger: IpcInteractionLogger;
}): void;
export declare function writeUserQuestionInteractionFailure(input: {
    ipcBaseDir: string;
    sourceAgentFolder: string;
    requestId: string;
    threadId?: string;
    responseKeyId?: string;
    logger: IpcInteractionLogger;
}): void;
