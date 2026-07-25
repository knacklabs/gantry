import fs from 'fs';
import path from 'path';

import type { UserQuestionCancellation } from '../domain/types.js';
import { IPC_CANCELLATION_RETENTION_TTL_MS } from '../shared/ipc-cancellation-lifetime.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import { interactionInFlightKey } from './ipc-interaction-processing.js';
import { parseQuestionCancellationIpcRequest } from './ipc-parsing.js';

const QUESTION_CANCELLATION_LANE = 'question-cancellations';
const CANCELLATION_RETRY_MIN_MS = 1_000;
const CANCELLATION_RETRY_MAX_MS = 30_000;

interface CancellationRetryState {
  attempts: number;
  cancellation: UserQuestionCancellation;
  expiresAt: number;
  nextAttemptAt: number;
}

const cancellationRetries = new Map<string, CancellationRetryState>();

type QuestionCancellationDirectoryLogger = {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
};

export async function processQuestionCancellationDirectory(input: {
  sourceAgentFolder: string;
  shouldProcessRequestLane(
    sourceAgentFolder: string,
    lane: typeof QUESTION_CANCELLATION_LANE,
  ): boolean;
  inFlightInteractionIpc: ReadonlySet<string>;
  runnerControlPort: FilesystemRunnerControlPort;
  cancelUserQuestion: IpcDeps['cancelUserQuestion'];
  logger: QuestionCancellationDirectoryLogger;
}): Promise<void> {
  const { sourceAgentFolder, runnerControlPort, logger } = input;
  const cancellationsDir = runnerControlPort.requestDir(
    sourceAgentFolder,
    QUESTION_CANCELLATION_LANE,
  );
  try {
    if (
      !input.shouldProcessRequestLane(
        sourceAgentFolder,
        QUESTION_CANCELLATION_LANE,
      ) ||
      !runnerControlPort.isTrustedRequestDir(
        sourceAgentFolder,
        QUESTION_CANCELLATION_LANE,
      )
    ) {
      return;
    }
    const files = runnerControlPort.listPendingRequests(
      sourceAgentFolder,
      QUESTION_CANCELLATION_LANE,
    );
    const now = Date.now();
    pruneExpiredRetryState(now);
    for (const file of files) {
      const retry = cancellationRetries.get(path.join(cancellationsDir, file));
      if (retry && retry.nextAttemptAt > now && retry.expiresAt > now) {
        continue;
      }
      await processQuestionCancellationFile(input, cancellationsDir, file);
    }
  } catch (err) {
    logger.error(
      { err, sourceAgentFolder },
      'Error reading question cancellation IPC requests directory',
    );
  }
}

async function processQuestionCancellationFile(
  input: Parameters<typeof processQuestionCancellationDirectory>[0],
  cancellationsDir: string,
  file: string,
): Promise<void> {
  const { sourceAgentFolder, runnerControlPort, logger } = input;
  let claimedPath = path.join(cancellationsDir, file);
  try {
    const claimed = runnerControlPort.claimRequest(
      sourceAgentFolder,
      QUESTION_CANCELLATION_LANE,
      file,
    );
    claimedPath = claimed.claimedPath;
    const pendingPath = path.join(cancellationsDir, file);
    const cancellation =
      cancellationRetries.get(pendingPath)?.cancellation ??
      parseQuestionCancellationIpcRequest(claimed.raw, sourceAgentFolder);
    if (!isQuestionInFlight(input.inFlightInteractionIpc, cancellation)) {
      if (
        runnerControlPort.responseExists(
          sourceAgentFolder,
          'user-answers',
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
    if (!input.cancelUserQuestion) {
      throw new Error('Question cancellation handler is unavailable');
    }
    const result = await input.cancelUserQuestion(cancellation);
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
      'Error processing question cancellation IPC request',
    );
    cancellationRetries.delete(path.join(cancellationsDir, file));
    runnerControlPort.archiveFailedRequest(
      sourceAgentFolder,
      file,
      claimedPath,
    );
  }
}

function isQuestionInFlight(
  inFlightInteractionIpc: ReadonlySet<string>,
  cancellation: UserQuestionCancellation,
): boolean {
  return inFlightInteractionIpc.has(
    interactionInFlightKey({
      sourceAgentFolder: cancellation.sourceAgentFolder,
      kind: 'user-question',
      threadId: cancellation.threadId,
      requestId: cancellation.requestId,
    }),
  );
}

function retainCancellation(input: {
  claimedPath: string;
  cancellationsDir: string;
  file: string;
  logger: QuestionCancellationDirectoryLogger;
  sourceAgentFolder: string;
  cancellation: UserQuestionCancellation;
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
      'Discarding expired question cancellation IPC request',
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
