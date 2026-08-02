import type { ClaimedRunnerControlRequest, IpcRootLockRecovery, RunnerControlContinuationInput, RunnerControlPort, RunnerControlRequestLane, RunnerControlResponseLane } from './runner-control-port.js';
export declare class FilesystemRunnerControlPort implements RunnerControlPort {
    readonly baseDir: string;
    constructor(baseDir: string);
    ensureRoot(): void;
    acquireRootLock(): string;
    recoverRootLock(lockPath: string): IpcRootLockRecovery;
    readRootLock(lockPath: string): {
        pid?: number;
        startedAt?: string;
    };
    releaseRootLock(lockPath: string): void;
    ensureWorkspaceLayout(workspaceFolder: string): void;
    hasCompleteTrustedWorkspaceLayout(workspaceFolder: string): boolean;
    isTrustedRegisteredWorkspace(workspaceFolder: string): boolean;
    requestDir(workspaceFolder: string, lane: RunnerControlRequestLane): string;
    requestDirExists(workspaceFolder: string, lane: RunnerControlRequestLane): boolean;
    isTrustedRequestDir(workspaceFolder: string, lane: RunnerControlRequestLane): boolean;
    listPendingRequests(workspaceFolder: string, lane: RunnerControlRequestLane): string[];
    claimRequest(workspaceFolder: string, lane: RunnerControlRequestLane, file: string): ClaimedRunnerControlRequest;
    removeClaimedRequest(claimedPath: string): void;
    archiveFailedRequest(workspaceFolder: string, file: string, claimedPath: string): void;
    responseExists(workspaceFolder: string, lane: RunnerControlResponseLane, requestId: string): boolean;
    writeContinuationInput(input: RunnerControlContinuationInput): void;
    writeCloseSignal(input: {
        workspaceFolder: string;
        threadId?: string | null;
    }): void;
    private continuationInputDir;
}
