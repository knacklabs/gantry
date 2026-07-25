import path from 'path';

import type { PermissionApprovalCancellation } from '../domain/types.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import { interactionInFlightKey } from './ipc-interaction-processing.js';
import { parsePermissionCancellationIpcRequest } from './ipc-parsing-permission-lifecycle.js';

const PERMISSION_CANCELLATION_LANE = 'permission-cancellations';

type PermissionCancellationDirectoryLogger = {
  error(context: Record<string, unknown>, message: string): void;
};

export async function processPermissionCancellationDirectory(input: {
  sourceAgentFolder: string;
  shouldProcessRequestLane(
    sourceAgentFolder: string,
    lane: typeof PERMISSION_CANCELLATION_LANE,
  ): boolean;
  inFlightInteractionIpc: ReadonlySet<string>;
  runnerControlPort: FilesystemRunnerControlPort;
  cancelPermissionApproval: IpcDeps['cancelPermissionApproval'];
  logger: PermissionCancellationDirectoryLogger;
}): Promise<void> {
  const { sourceAgentFolder, runnerControlPort, logger } = input;
  const cancellationsDir = runnerControlPort.requestDir(
    sourceAgentFolder,
    PERMISSION_CANCELLATION_LANE,
  );
  try {
    if (
      !input.shouldProcessRequestLane(
        sourceAgentFolder,
        PERMISSION_CANCELLATION_LANE,
      ) ||
      !runnerControlPort.isTrustedRequestDir(
        sourceAgentFolder,
        PERMISSION_CANCELLATION_LANE,
      )
    ) {
      return;
    }
    const files = runnerControlPort.listPendingRequests(
      sourceAgentFolder,
      PERMISSION_CANCELLATION_LANE,
    );
    for (const file of files) {
      await processPermissionCancellationFile(input, cancellationsDir, file);
    }
  } catch (err) {
    logger.error(
      { err, sourceAgentFolder },
      'Error reading permission cancellation IPC requests directory',
    );
  }
}

async function processPermissionCancellationFile(
  input: Parameters<typeof processPermissionCancellationDirectory>[0],
  cancellationsDir: string,
  file: string,
): Promise<void> {
  const { sourceAgentFolder, runnerControlPort, logger } = input;
  let claimedPath = path.join(cancellationsDir, file);
  try {
    const claimed = runnerControlPort.claimRequest(
      sourceAgentFolder,
      PERMISSION_CANCELLATION_LANE,
      file,
    );
    claimedPath = claimed.claimedPath;
    const cancellation = parsePermissionCancellationIpcRequest(
      claimed.raw,
      sourceAgentFolder,
    );
    if (!isPermissionInFlight(input.inFlightInteractionIpc, cancellation)) {
      runnerControlPort.removeClaimedRequest(claimedPath);
      return;
    }
    if (!input.cancelPermissionApproval) {
      throw new Error('Permission cancellation handler is unavailable');
    }
    await input.cancelPermissionApproval(cancellation);
    runnerControlPort.removeClaimedRequest(claimedPath);
  } catch (err) {
    logger.error(
      { file, sourceAgentFolder, err },
      'Error processing permission cancellation IPC request',
    );
    runnerControlPort.archiveFailedRequest(
      sourceAgentFolder,
      file,
      claimedPath,
    );
  }
}

function isPermissionInFlight(
  inFlightInteractionIpc: ReadonlySet<string>,
  cancellation: PermissionApprovalCancellation,
): boolean {
  return inFlightInteractionIpc.has(
    interactionInFlightKey({
      sourceAgentFolder: cancellation.sourceAgentFolder,
      kind: 'permission',
      threadId: cancellation.threadId,
      requestId: cancellation.requestId,
    }),
  );
}
