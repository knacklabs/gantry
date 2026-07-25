import fs from 'fs';
import path from 'path';

import type { PermissionApprovalCancellation } from '../domain/types.js';
import { IPC_CANCELLATION_RETENTION_TTL_MS } from '../shared/ipc-cancellation-lifetime.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import { interactionInFlightKey } from './ipc-interaction-processing.js';
import { parsePermissionCancellationIpcRequest } from './ipc-parsing-permission-lifecycle.js';

const PERMISSION_CANCELLATION_LANE = 'permission-cancellations';
const CANCELLATION_RETRY_MIN_MS = 1_000;
const CANCELLATION_RETRY_MAX_MS = 30_000;

interface CancellationRetryState {
  attempts: number;
  cancellation: PermissionApprovalCancellation;
  expiresAt: number;
  nextAttemptAt: number;
}

const cancellationRetries = new Map<string, CancellationRetryState>();

type PermissionCancellationDirectoryLogger = {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
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
    const now = Date.now();
    pruneExpiredRetryState(now);
    for (const file of files) {
      const retry = cancellationRetries.get(path.join(cancellationsDir, file));
      if (retry && retry.nextAttemptAt > now && retry.expiresAt > now) {
        continue;
      }
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
    const pendingPath = path.join(cancellationsDir, file);
    const cancellation =
      cancellationRetries.get(pendingPath)?.cancellation ??
      parsePermissionCancellationIpcRequest(claimed.raw, sourceAgentFolder);
    if (!isPermissionInFlight(input.inFlightInteractionIpc, cancellation)) {
      if (
        runnerControlPort.responseExists(
          sourceAgentFolder,
          'permission-responses',
          cancellation.requestId,
        )
      ) {
        consumeCancellation(claimedPath, cancellationsDir, file);
        return;
      }
      retainCancellation({
        claimedPath,
        cancellationsDir,
        file,
        logger,
        sourceAgentFolder,
        cancellation,
      });
      return;
    }
    if (!input.cancelPermissionApproval) {
      throw new Error('Permission cancellation handler is unavailable');
    }
    const result = await input.cancelPermissionApproval(cancellation);
    if (result === 'settled') {
      consumeCancellation(claimedPath, cancellationsDir, file);
      return;
    }
    retainCancellation({
      claimedPath,
      cancellationsDir,
      file,
      logger,
      sourceAgentFolder,
      cancellation,
    });
  } catch (err) {
    logger.error(
      { file, sourceAgentFolder, err },
      'Error processing permission cancellation IPC request',
    );
    cancellationRetries.delete(path.join(cancellationsDir, file));
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

function retainCancellation(input: {
  claimedPath: string;
  cancellationsDir: string;
  file: string;
  logger: PermissionCancellationDirectoryLogger;
  sourceAgentFolder: string;
  cancellation: PermissionApprovalCancellation;
}): void {
  const pendingPath = path.join(input.cancellationsDir, input.file);
  const now = Date.now();
  const previous = cancellationRetries.get(pendingPath);
  const expiresAt =
    previous?.expiresAt ??
    Math.min(now, fs.statSync(input.claimedPath).mtimeMs) +
      IPC_CANCELLATION_RETENTION_TTL_MS;
  if (expiresAt <= now) {
    fs.unlinkSync(input.claimedPath);
    cancellationRetries.delete(pendingPath);
    input.logger.warn(
      {
        file: input.file,
        sourceAgentFolder: input.sourceAgentFolder,
        retentionMs: IPC_CANCELLATION_RETENTION_TTL_MS,
      },
      'Discarding expired permission cancellation IPC request',
    );
    return;
  }

  fs.renameSync(input.claimedPath, pendingPath);
  const attempts = (previous?.attempts ?? 0) + 1;
  const retryDelayMs = Math.min(
    CANCELLATION_RETRY_MIN_MS * 2 ** (attempts - 1),
    CANCELLATION_RETRY_MAX_MS,
  );
  cancellationRetries.set(pendingPath, {
    attempts,
    cancellation: input.cancellation,
    expiresAt,
    nextAttemptAt: now + retryDelayMs,
  });
}

function consumeCancellation(
  claimedPath: string,
  cancellationsDir: string,
  file: string,
): void {
  fs.unlinkSync(claimedPath);
  cancellationRetries.delete(path.join(cancellationsDir, file));
}

function pruneExpiredRetryState(now: number): void {
  for (const [pendingPath, retry] of cancellationRetries) {
    if (retry.expiresAt <= now && !fs.existsSync(pendingPath)) {
      cancellationRetries.delete(pendingPath);
    }
  }
}
