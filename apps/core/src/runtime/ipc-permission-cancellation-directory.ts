import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import type { PermissionApprovalCancellation } from '../domain/types.js';
import { IPC_CANCELLATION_RETENTION_TTL_MS } from '../shared/ipc-cancellation-lifetime.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import {
  claimDurableCancellationRecord,
  createDurableCancellationRecord,
  durableCancellationRecordsDir,
  listDurableCancellationRecords,
  readDurableCancellationRecord,
  releaseDurableCancellationRecord,
  type DurableCancellationRecord,
} from './ipc-cancellation-durable-record.js';
import { interactionInFlightKey } from './ipc-interaction-processing.js';
import { parsePermissionCancellationIpcRequest } from './ipc-parsing-permission-lifecycle.js';

const PERMISSION_CANCELLATION_LANE = 'permission-cancellations';
const CANCELLATION_RETRY_MIN_MS = 1_000;
const CANCELLATION_RETRY_MAX_MS = 30_000;

type CancellationRetryState =
  DurableCancellationRecord<PermissionApprovalCancellation>;

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
    const recordsDir = durableCancellationRecordsDir(
      runnerControlPort.baseDir,
      PERMISSION_CANCELLATION_LANE,
      sourceAgentFolder,
    );
    const retryFiles = listDurableCancellationRecords(recordsDir);
    const now = Date.now();
    for (const file of files) {
      await ingestPermissionCancellationFile(
        input,
        cancellationsDir,
        recordsDir,
        file,
      );
    }
    for (const file of retryFiles) {
      const retry = loadPendingCancellationRetryState(recordsDir, file);
      if (retry && retry.nextAttemptAt > now && retry.expiresAt > now) {
        continue;
      }
      await processPermissionCancellationRecord(input, recordsDir, file);
    }
  } catch (err) {
    logger.error(
      { err, sourceAgentFolder },
      'Error reading permission cancellation IPC requests directory',
    );
  }
}

async function ingestPermissionCancellationFile(
  input: Parameters<typeof processPermissionCancellationDirectory>[0],
  cancellationsDir: string,
  recordsDir: string,
  file: string,
): Promise<void> {
  const { sourceAgentFolder, runnerControlPort, logger } = input;
  let claimedPath = path.join(cancellationsDir, file);
  let recordFile: string | undefined;
  try {
    const claimed = runnerControlPort.claimRequest(
      sourceAgentFolder,
      PERMISSION_CANCELLATION_LANE,
      file,
    );
    claimedPath = claimed.claimedPath;
    const envelopeDigest = cancellationEnvelopeDigest(claimed.raw);
    const cancellation = parsePermissionCancellationIpcRequest(
      claimed.raw,
      sourceAgentFolder,
    );
    const now = Date.now();
    recordFile = createDurableCancellationRecord(recordsDir, {
      attempts: 0,
      cancellation,
      envelopeDigest,
      expiresAt:
        Math.min(now, fs.statSync(claimedPath).mtimeMs) +
        IPC_CANCELLATION_RETENTION_TTL_MS,
      nextAttemptAt: now,
    });
    fs.unlinkSync(claimedPath);
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
    return;
  }
  await processPermissionCancellationRecord(input, recordsDir, recordFile);
}

async function processPermissionCancellationRecord(
  input: Parameters<typeof processPermissionCancellationDirectory>[0],
  recordsDir: string,
  file: string,
): Promise<void> {
  const { sourceAgentFolder, runnerControlPort, logger } = input;
  let claimedPath = path.join(recordsDir, file);
  try {
    claimedPath = claimDurableCancellationRecord(recordsDir, file);
    const retry =
      readDurableCancellationRecord<PermissionApprovalCancellation>(
        claimedPath,
      );
    const cancellation = retry.cancellation;
    if (!isPermissionInFlight(input.inFlightInteractionIpc, cancellation)) {
      if (
        runnerControlPort.responseExists(
          sourceAgentFolder,
          'permission-responses',
          cancellation.requestId,
        )
      ) {
        fs.unlinkSync(claimedPath);
        return;
      }
      retainCancellation({
        claimedPath,
        recordsDir,
        file,
        logger,
        sourceAgentFolder,
        retry,
      });
      return;
    }
    if (!input.cancelPermissionApproval) {
      throw new Error('Permission cancellation handler is unavailable');
    }
    let result: Awaited<
      ReturnType<NonNullable<IpcDeps['cancelPermissionApproval']>>
    >;
    try {
      result = await input.cancelPermissionApproval(cancellation);
    } catch (err) {
      logger.error(
        { file, sourceAgentFolder, err },
        'Error processing permission cancellation IPC request',
      );
      retainCancellation({
        claimedPath,
        recordsDir,
        file,
        logger,
        sourceAgentFolder,
        retry,
      });
      return;
    }
    if (result === 'settled') {
      fs.unlinkSync(claimedPath);
      return;
    }
    retainCancellation({
      claimedPath,
      recordsDir,
      file,
      logger,
      sourceAgentFolder,
      retry,
    });
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

function retainCancellation(input: {
  claimedPath: string;
  recordsDir: string;
  file: string;
  logger: PermissionCancellationDirectoryLogger;
  sourceAgentFolder: string;
  retry: CancellationRetryState;
}): void {
  const now = Date.now();
  if (input.retry.expiresAt <= now) {
    fs.unlinkSync(input.claimedPath);
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

  const attempts = input.retry.attempts + 1;
  const retryDelayMs = Math.min(
    CANCELLATION_RETRY_MIN_MS * 2 ** (attempts - 1),
    CANCELLATION_RETRY_MAX_MS,
  );
  releaseDurableCancellationRecord(
    input.claimedPath,
    path.join(input.recordsDir, input.file),
    {
      ...input.retry,
      attempts,
      nextAttemptAt: now + retryDelayMs,
    },
  );
}

function cancellationEnvelopeDigest(raw: unknown): string {
  return createHash('sha256').update(JSON.stringify(raw)).digest('hex');
}

function loadPendingCancellationRetryState(
  recordsDir: string,
  file: string,
): CancellationRetryState | undefined {
  try {
    return readDurableCancellationRecord<PermissionApprovalCancellation>(
      path.join(recordsDir, file),
    );
  } catch {
    return undefined;
  }
}
