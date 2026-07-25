import path from 'path';

import type { UserQuestionCancellation } from '../domain/types.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import { interactionInFlightKey } from './ipc-interaction-processing.js';
import { parseQuestionCancellationIpcRequest } from './ipc-parsing.js';

const QUESTION_CANCELLATION_LANE = 'question-cancellations';

type QuestionCancellationDirectoryLogger = {
  error(context: Record<string, unknown>, message: string): void;
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
    for (const file of files) {
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
    const cancellation = parseQuestionCancellationIpcRequest(
      claimed.raw,
      sourceAgentFolder,
    );
    if (!isQuestionInFlight(input.inFlightInteractionIpc, cancellation)) {
      runnerControlPort.removeClaimedRequest(claimedPath);
      return;
    }
    if (!input.cancelUserQuestion) {
      throw new Error('Question cancellation handler is unavailable');
    }
    await input.cancelUserQuestion(cancellation);
    runnerControlPort.removeClaimedRequest(claimedPath);
  } catch (err) {
    logger.error(
      { file, sourceAgentFolder, err },
      'Error processing question cancellation IPC request',
    );
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
