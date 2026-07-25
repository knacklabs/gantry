import { parseQuestionCancellationIpcRequest } from './ipc-parsing.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import {
  processCancellationDirectory,
  type CancellationDirectoryLogger,
} from './ipc-cancellation-directory.js';

const QUESTION_CANCELLATION_LANE = 'question-cancellations';

export async function processQuestionCancellationDirectory(input: {
  sourceAgentFolder: string;
  shouldProcessRequestLane(
    sourceAgentFolder: string,
    lane: typeof QUESTION_CANCELLATION_LANE,
  ): boolean;
  inFlightInteractionIpc: ReadonlySet<string>;
  runnerControlPort: FilesystemRunnerControlPort;
  cancelUserQuestion: IpcDeps['cancelUserQuestion'];
  logger: CancellationDirectoryLogger;
}): Promise<void> {
  return processCancellationDirectory(input, {
    requestLane: QUESTION_CANCELLATION_LANE,
    responseLane: 'user-answers',
    inFlightKind: 'user-question',
    parser: parseQuestionCancellationIpcRequest,
    handler: input.cancelUserQuestion,
    missingHandlerErrorLabel: 'Question cancellation',
    logLabel: 'question cancellation',
  });
}
