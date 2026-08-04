interface IpcRootLockDetails {
    pid?: number;
    startedAt?: string;
}
export declare function isTrustedDirectory(dirPath: string): boolean;
export declare function ensureWorkspaceIpcLayout(ipcBaseDir: string, workspaceFolder: string): void;
export declare function hasCompleteTrustedWorkspaceIpcLayout(ipcBaseDir: string, workspaceFolder: string): boolean;
export declare function claimIpcFile(filePath: string): string;
export declare function isPendingIpcJsonFile(filename: string): boolean;
export declare function archiveIpcErrorFile(ipcBaseDir: string, sourceAgentFolder: string, filename: string, claimedPath: string, lane?: string): void;
export declare function readIpcRootLockDetails(lockPath: string): IpcRootLockDetails;
export declare function recoverStaleIpcRootLock(lockPath: string): IpcRootLockDetails & {
    recovered: boolean;
    recoveryReason?: string;
};
export declare function acquireIpcRootLock(ipcBaseDir: string): string;
export {};
