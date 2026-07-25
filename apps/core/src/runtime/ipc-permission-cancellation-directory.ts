import { parsePermissionCancellationIpcRequest } from './ipc-parsing-permission-lifecycle.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import {
  processCancellationDirectory,
  type CancellationDirectoryLogger,
} from './ipc-cancellation-directory.js';

const PERMISSION_CANCELLATION_LANE = 'permission-cancellations';

export async function processPermissionCancellationDirectory(input: {
  sourceAgentFolder: string;
  shouldProcessRequestLane(
    sourceAgentFolder: string,
    lane: typeof PERMISSION_CANCELLATION_LANE,
  ): boolean;
  inFlightInteractionIpc: ReadonlySet<string>;
  runnerControlPort: FilesystemRunnerControlPort;
  cancelPermissionApproval: IpcDeps['cancelPermissionApproval'];
  publishRuntimeEvent?: IpcDeps['publishRuntimeEvent'];
  logger: CancellationDirectoryLogger;
}): Promise<void> {
  return processCancellationDirectory(input, {
    requestLane: PERMISSION_CANCELLATION_LANE,
    responseLane: 'permission-responses',
    inFlightKind: 'permission',
    requestIdField: 'permissionRequestId',
    parser: parsePermissionCancellationIpcRequest,
    handler: input.cancelPermissionApproval,
    missingHandlerErrorLabel: 'Permission cancellation',
    logLabel: 'permission cancellation',
  });
}
