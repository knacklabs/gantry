import fs from 'fs';
import path from 'path';

import { getContinuationInputNamespace } from './continuation-input.js';
import {
  acquireIpcRootLock,
  archiveIpcErrorFile,
  claimIpcFile,
  ensureWorkspaceIpcLayout,
  hasCompleteTrustedWorkspaceIpcLayout,
  isPendingIpcJsonFile,
  isTrustedDirectory,
  readIpcRootLockDetails,
  recoverStaleIpcRootLock,
} from './ipc-filesystem.js';
import { ensurePrivateDirSync } from '../shared/private-fs.js';
import type {
  ClaimedRunnerControlRequest,
  IpcRootLockRecovery,
  RunnerControlContinuationInput,
  RunnerControlPort,
  RunnerControlRequestLane,
  RunnerControlResponseLane,
} from './runner-control-port.js';

export class FilesystemRunnerControlPort implements RunnerControlPort {
  constructor(readonly baseDir: string) {}

  ensureRoot(): void {
    ensurePrivateDirSync(this.baseDir);
  }

  acquireRootLock(): string {
    return acquireIpcRootLock(this.baseDir);
  }

  recoverRootLock(lockPath: string): IpcRootLockRecovery {
    return recoverStaleIpcRootLock(lockPath);
  }

  readRootLock(lockPath: string): { pid?: number; startedAt?: string } {
    return readIpcRootLockDetails(lockPath);
  }

  releaseRootLock(lockPath: string): void {
    fs.rmSync(lockPath, { force: true });
  }

  ensureWorkspaceLayout(workspaceFolder: string): void {
    ensureWorkspaceIpcLayout(this.baseDir, workspaceFolder);
  }

  hasCompleteTrustedWorkspaceLayout(workspaceFolder: string): boolean {
    return hasCompleteTrustedWorkspaceIpcLayout(this.baseDir, workspaceFolder);
  }

  isTrustedRegisteredWorkspace(workspaceFolder: string): boolean {
    const workspaceDir = path.join(this.baseDir, workspaceFolder);
    return !fs.existsSync(workspaceDir) || isTrustedDirectory(workspaceDir);
  }

  requestDir(workspaceFolder: string, lane: RunnerControlRequestLane): string {
    return path.join(this.baseDir, workspaceFolder, lane);
  }

  requestDirExists(
    workspaceFolder: string,
    lane: RunnerControlRequestLane,
  ): boolean {
    return fs.existsSync(this.requestDir(workspaceFolder, lane));
  }

  isTrustedRequestDir(
    workspaceFolder: string,
    lane: RunnerControlRequestLane,
  ): boolean {
    return isTrustedDirectory(this.requestDir(workspaceFolder, lane));
  }

  listPendingRequests(
    workspaceFolder: string,
    lane: RunnerControlRequestLane,
  ): string[] {
    if (!this.isTrustedRequestDir(workspaceFolder, lane)) return [];
    return fs
      .readdirSync(this.requestDir(workspaceFolder, lane))
      .filter(isPendingIpcJsonFile);
  }

  claimRequest(
    workspaceFolder: string,
    lane: RunnerControlRequestLane,
    file: string,
  ): ClaimedRunnerControlRequest {
    const filePath = path.join(this.requestDir(workspaceFolder, lane), file);
    const claimedPath = claimIpcFile(filePath);
    try {
      return {
        file,
        path: filePath,
        claimedPath,
        raw: JSON.parse(fs.readFileSync(claimedPath, 'utf-8')),
      };
    } catch (error) {
      this.archiveFailedRequest(workspaceFolder, file, claimedPath);
      throw error;
    }
  }

  removeClaimedRequest(claimedPath: string): void {
    fs.unlinkSync(claimedPath);
  }

  archiveFailedRequest(
    workspaceFolder: string,
    file: string,
    claimedPath: string,
  ): void {
    archiveIpcErrorFile(this.baseDir, workspaceFolder, file, claimedPath);
  }

  responseExists(
    workspaceFolder: string,
    lane: RunnerControlResponseLane,
    requestId: string,
  ): boolean {
    return fs.existsSync(
      path.join(this.baseDir, workspaceFolder, lane, `${requestId}.json`),
    );
  }

  writeContinuationInput(input: RunnerControlContinuationInput): void {
    const inputDir = this.continuationInputDir(
      input.workspaceFolder,
      input.threadId,
    );
    fs.mkdirSync(inputDir, { recursive: true });
    const filepath = path.join(
      inputDir,
      `${Date.now()}-${String(input.sequence).padStart(12, '0')}.json`,
    );
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(
      tempPath,
      JSON.stringify({
        type: 'message',
        text: input.text,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      }),
    );
    fs.renameSync(tempPath, filepath);
  }

  writeCloseSignal(input: {
    workspaceFolder: string;
    threadId?: string | null;
  }): void {
    const inputDir = this.continuationInputDir(
      input.workspaceFolder,
      input.threadId,
    );
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, '_close'), '');
  }

  private continuationInputDir(
    workspaceFolder: string,
    threadId?: string | null,
  ): string {
    return path.join(
      this.baseDir,
      workspaceFolder,
      getContinuationInputNamespace(threadId),
    );
  }
}
