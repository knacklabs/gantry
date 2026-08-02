import type { UserQuestionRequest } from '../domain/types.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { ParsedPermissionIpcRequest } from './ipc-parsing.js';
import { publishPendingInteractionRuntimeEvent } from './ipc-interaction-runtime-events.js';
export { publishPendingInteractionRuntimeEvent };
export { writePermissionInteractionFailure, writeUserQuestionInteractionFailure, } from './ipc-interaction-failure.js';
type LogContext = Record<string, unknown>;
export type IpcInteractionLogger = {
    info?(context: LogContext, message: string): void;
    warn(context: LogContext, message: string): void;
    error(context: LogContext, message: string): void;
};
export declare function interactionInFlightKey(input: {
    sourceAgentFolder: string;
    kind: 'permission' | 'rich-interaction' | 'user-question';
    threadId?: string;
    requestId: string;
}): string;
export declare function processPermissionInteractionIpc(input: {
    request: ParsedPermissionIpcRequest;
    sourceAgentFolder: string;
    deps: IpcDeps;
    ipcBaseDir: string;
    file: string;
    claimedPath: string;
    logger: IpcInteractionLogger;
}): Promise<void>;
export declare function processUserQuestionInteractionIpc(input: {
    request: UserQuestionRequest;
    sourceAgentFolder: string;
    deps: IpcDeps;
    ipcBaseDir: string;
    file: string;
    claimedPath: string;
    logger: IpcInteractionLogger;
}): Promise<void>;
