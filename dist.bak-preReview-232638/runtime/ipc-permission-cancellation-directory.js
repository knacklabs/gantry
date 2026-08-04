import { parsePermissionCancellationIpcRequest } from './ipc-parsing-permission-lifecycle.js';
import { processCancellationDirectory, } from './ipc-cancellation-directory.js';
const PERMISSION_CANCELLATION_LANE = 'permission-cancellations';
export async function processPermissionCancellationDirectory(input) {
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
