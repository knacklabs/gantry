import type { IpcDeps } from './ipc-domain-types.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import { type CancellationDirectoryLogger } from './ipc-cancellation-directory.js';
declare const QUESTION_CANCELLATION_LANE = "question-cancellations";
export declare function processQuestionCancellationDirectory(input: {
    sourceAgentFolder: string;
    shouldProcessRequestLane(sourceAgentFolder: string, lane: typeof QUESTION_CANCELLATION_LANE): boolean;
    inFlightInteractionIpc: ReadonlySet<string>;
    runnerControlPort: FilesystemRunnerControlPort;
    cancelUserQuestion: IpcDeps['cancelUserQuestion'];
    publishRuntimeEvent?: IpcDeps['publishRuntimeEvent'];
    logger: CancellationDirectoryLogger;
}): Promise<void>;
export {};
