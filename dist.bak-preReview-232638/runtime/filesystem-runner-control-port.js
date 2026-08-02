import fs from 'fs';
import path from 'path';
import { getContinuationInputNamespace } from './continuation-input.js';
import { acquireIpcRootLock, archiveIpcErrorFile, claimIpcFile, ensureWorkspaceIpcLayout, hasCompleteTrustedWorkspaceIpcLayout, isPendingIpcJsonFile, isTrustedDirectory, readIpcRootLockDetails, recoverStaleIpcRootLock, } from './ipc-filesystem.js';
import { ensurePrivateDirSync } from '../shared/private-fs.js';
export class FilesystemRunnerControlPort {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    ensureRoot() {
        ensurePrivateDirSync(this.baseDir);
    }
    acquireRootLock() {
        return acquireIpcRootLock(this.baseDir);
    }
    recoverRootLock(lockPath) {
        return recoverStaleIpcRootLock(lockPath);
    }
    readRootLock(lockPath) {
        return readIpcRootLockDetails(lockPath);
    }
    releaseRootLock(lockPath) {
        fs.rmSync(lockPath, { force: true });
    }
    ensureWorkspaceLayout(workspaceFolder) {
        ensureWorkspaceIpcLayout(this.baseDir, workspaceFolder);
    }
    hasCompleteTrustedWorkspaceLayout(workspaceFolder) {
        return hasCompleteTrustedWorkspaceIpcLayout(this.baseDir, workspaceFolder);
    }
    isTrustedRegisteredWorkspace(workspaceFolder) {
        const workspaceDir = path.join(this.baseDir, workspaceFolder);
        return !fs.existsSync(workspaceDir) || isTrustedDirectory(workspaceDir);
    }
    requestDir(workspaceFolder, lane) {
        return path.join(this.baseDir, workspaceFolder, lane);
    }
    requestDirExists(workspaceFolder, lane) {
        return fs.existsSync(this.requestDir(workspaceFolder, lane));
    }
    isTrustedRequestDir(workspaceFolder, lane) {
        return isTrustedDirectory(this.requestDir(workspaceFolder, lane));
    }
    listPendingRequests(workspaceFolder, lane) {
        if (!this.isTrustedRequestDir(workspaceFolder, lane))
            return [];
        return fs
            .readdirSync(this.requestDir(workspaceFolder, lane))
            .filter(isPendingIpcJsonFile);
    }
    claimRequest(workspaceFolder, lane, file) {
        const filePath = path.join(this.requestDir(workspaceFolder, lane), file);
        const claimedPath = claimIpcFile(filePath);
        try {
            return {
                file,
                path: filePath,
                claimedPath,
                raw: JSON.parse(fs.readFileSync(claimedPath, 'utf-8')),
            };
        }
        catch (error) {
            this.archiveFailedRequest(workspaceFolder, file, claimedPath);
            throw error;
        }
    }
    removeClaimedRequest(claimedPath) {
        fs.unlinkSync(claimedPath);
    }
    archiveFailedRequest(workspaceFolder, file, claimedPath) {
        archiveIpcErrorFile(this.baseDir, workspaceFolder, file, claimedPath);
    }
    responseExists(workspaceFolder, lane, requestId) {
        return fs.existsSync(path.join(this.baseDir, workspaceFolder, lane, `${requestId}.json`));
    }
    writeContinuationInput(input) {
        const inputDir = this.continuationInputDir(input.workspaceFolder, input.threadId);
        fs.mkdirSync(inputDir, { recursive: true });
        const filepath = path.join(inputDir, `${Date.now()}-${String(input.sequence).padStart(12, '0')}.json`);
        const tempPath = `${filepath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify({
            type: 'message',
            text: input.text,
            ...(input.threadId ? { threadId: input.threadId } : {}),
        }));
        fs.renameSync(tempPath, filepath);
    }
    writeCloseSignal(input) {
        const inputDir = this.continuationInputDir(input.workspaceFolder, input.threadId);
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, '_close'), '');
    }
    continuationInputDir(workspaceFolder, threadId) {
        return path.join(this.baseDir, workspaceFolder, getContinuationInputNamespace(threadId));
    }
}
