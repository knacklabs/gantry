import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { RunnerControlRequestLane, RunnerControlResponseLane } from './runner-control-port.js';
type Cancellation = {
    requestId: string;
    appId?: string;
    sourceAgentFolder: string;
    threadId?: string;
    reason?: string;
};
type CancellationRequestLane = Extract<RunnerControlRequestLane, 'permission-cancellations' | 'question-cancellations'>;
type CancellationResponseLane = Extract<RunnerControlResponseLane, 'permission-responses' | 'user-answers'>;
type CancellationResult = 'settled' | 'queued' | 'not_found';
export type CancellationDirectoryLogger = {
    error(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
};
export declare function processCancellationDirectory<Lane extends CancellationRequestLane, Payload extends Cancellation>(input: {
    sourceAgentFolder: string;
    shouldProcessRequestLane(sourceAgentFolder: string, lane: Lane): boolean;
    inFlightInteractionIpc: ReadonlySet<string>;
    runnerControlPort: FilesystemRunnerControlPort;
    publishRuntimeEvent?: IpcDeps['publishRuntimeEvent'];
    logger: CancellationDirectoryLogger;
}, lane: {
    requestLane: Lane;
    responseLane: CancellationResponseLane;
    inFlightKind: 'permission' | 'user-question';
    requestIdField: 'permissionRequestId' | 'questionRequestId';
    parser(raw: unknown, sourceAgentFolder: string): Payload;
    handler: ((cancellation: Payload) => Promise<CancellationResult>) | undefined;
    missingHandlerErrorLabel: string;
    logLabel: string;
}): Promise<void>;
export {};
