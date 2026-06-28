export type RunnerControlRequestLane =
  | 'messages'
  | 'tasks'
  | 'memory-requests'
  | 'browser-requests'
  | 'permission-requests'
  | 'rich-interactions'
  | 'user-questions';

export type RunnerControlResponseLane =
  | 'browser-responses'
  | 'memory-responses'
  | 'permission-responses'
  | 'task-responses'
  | 'user-answers';

export interface ClaimedRunnerControlRequest {
  file: string;
  path: string;
  claimedPath: string;
  raw: unknown;
}

export interface IpcRootLockRecovery {
  recovered: boolean;
  pid?: number;
  startedAt?: string;
  recoveryReason?: string;
}

export interface RunnerControlContinuationInput {
  workspaceFolder: string;
  text: string;
  sequence: number;
  threadId?: string | null;
}

export interface RunnerControlPort {
  readonly baseDir: string;
  ensureRoot(): void;
  acquireRootLock(): string;
  recoverRootLock(lockPath: string): IpcRootLockRecovery;
  readRootLock(lockPath: string): { pid?: number; startedAt?: string };
  releaseRootLock(lockPath: string): void;
  ensureWorkspaceLayout(workspaceFolder: string): void;
  hasCompleteTrustedWorkspaceLayout(workspaceFolder: string): boolean;
  isTrustedRegisteredWorkspace(workspaceFolder: string): boolean;
  requestDir(workspaceFolder: string, lane: RunnerControlRequestLane): string;
  requestDirExists(
    workspaceFolder: string,
    lane: RunnerControlRequestLane,
  ): boolean;
  isTrustedRequestDir(
    workspaceFolder: string,
    lane: RunnerControlRequestLane,
  ): boolean;
  listPendingRequests(
    workspaceFolder: string,
    lane: RunnerControlRequestLane,
  ): string[];
  claimRequest(
    workspaceFolder: string,
    lane: RunnerControlRequestLane,
    file: string,
  ): ClaimedRunnerControlRequest;
  removeClaimedRequest(claimedPath: string): void;
  archiveFailedRequest(
    workspaceFolder: string,
    file: string,
    claimedPath: string,
  ): void;
  responseExists(
    workspaceFolder: string,
    lane: RunnerControlResponseLane,
    requestId: string,
  ): boolean;
  writeContinuationInput(input: RunnerControlContinuationInput): void;
  writeCloseSignal(input: {
    workspaceFolder: string;
    threadId?: string | null;
  }): void;
}

export interface DurableRunnerControlClaim {
  claimId: string;
  workspaceFolder: string;
  lane: RunnerControlRequestLane;
  payload: unknown;
}

export interface DurableRunnerControlPort {
  claimNextRequest(input: {
    workspaceFolder: string;
    lanes: RunnerControlRequestLane[];
  }): Promise<DurableRunnerControlClaim | null>;
  completeClaim(claimId: string): Promise<void>;
  archiveClaimError(input: { claimId: string; error?: string }): Promise<void>;
  writeContinuationInput(input: RunnerControlContinuationInput): Promise<void>;
}
