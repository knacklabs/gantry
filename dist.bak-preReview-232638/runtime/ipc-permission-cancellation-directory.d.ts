import type { IpcDeps } from './ipc-domain-types.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import { type CancellationDirectoryLogger } from './ipc-cancellation-directory.js';
declare const PERMISSION_CANCELLATION_LANE = "permission-cancellations";
export declare function processPermissionCancellationDirectory(input: {
    sourceAgentFolder: string;
    shouldProcessRequestLane(sourceAgentFolder: string, lane: typeof PERMISSION_CANCELLATION_LANE): boolean;
    inFlightInteractionIpc: ReadonlySet<string>;
    runnerControlPort: FilesystemRunnerControlPort;
    cancelPermissionApproval: IpcDeps['cancelPermissionApproval'];
    publishRuntimeEvent?: IpcDeps['publishRuntimeEvent'];
    logger: CancellationDirectoryLogger;
}): Promise<void>;
export {};
