import fs from 'fs';
import path from 'path';

import { nowIso, nowMs } from '../infrastructure/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import { IPC_GROUP_SUBDIRS } from './agent-spawn-layout.js';

interface IpcRootLockDetails {
  pid?: number;
  startedAt?: string;
}

export function isTrustedDirectory(dirPath: string): boolean {
  try {
    const stat = fs.lstatSync(dirPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function ensureGroupIpcLayout(
  ipcBaseDir: string,
  groupFolder: string,
): void {
  const groupDir = path.join(ipcBaseDir, groupFolder);
  for (const subdir of IPC_GROUP_SUBDIRS) {
    fs.mkdirSync(path.join(groupDir, subdir), { recursive: true });
  }
}

export function hasCompleteTrustedGroupIpcLayout(
  ipcBaseDir: string,
  groupFolder: string,
): boolean {
  const groupDir = path.join(ipcBaseDir, groupFolder);
  if (!isTrustedDirectory(groupDir)) return false;
  for (const subdir of IPC_GROUP_SUBDIRS) {
    if (!isTrustedDirectory(path.join(groupDir, subdir))) return false;
  }
  return true;
}

export function claimIpcFile(filePath: string): string {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('IPC payload must be a regular file');
  }
  const claimed = path.join(
    path.dirname(filePath),
    `.processing-${process.pid}-${nowMs()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(filePath)}`,
  );
  fs.renameSync(filePath, claimed);
  return claimed;
}

export function isPendingIpcJsonFile(filename: string): boolean {
  return filename.endsWith('.json') && !filename.startsWith('.processing-');
}

export function archiveIpcErrorFile(
  ipcBaseDir: string,
  sourceAgentFolder: string,
  filename: string,
  claimedPath: string,
): void {
  const errorDir = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(errorDir, { recursive: true });
  try {
    fs.renameSync(
      claimedPath,
      path.join(errorDir, `${sourceAgentFolder}-${filename}`),
    );
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
    if (code !== 'ENOENT') {
      throw err;
    }
  }
}

export function readIpcRootLockDetails(lockPath: string): IpcRootLockDetails {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return {};
    const pidRaw = parsed.pid;
    const pid =
      typeof pidRaw === 'number' && Number.isInteger(pidRaw) && pidRaw > 0
        ? pidRaw
        : undefined;
    const startedAt = toTrimmedString(parsed.startedAt, { maxLen: 128 });
    return { pid, startedAt };
  } catch {
    return {};
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    logger.warn(
      { err, pid },
      'Unable to validate IPC lock PID liveness, assuming process is active',
    );
    return true;
  }
}

export function recoverStaleIpcRootLock(
  lockPath: string,
): IpcRootLockDetails & { recovered: boolean; recoveryReason?: string } {
  const details = readIpcRootLockDetails(lockPath);
  if (typeof details.pid !== 'number') {
    return {
      ...details,
      recovered: false,
      recoveryReason: 'invalid_or_missing_pid',
    };
  }
  if (details.pid === process.pid) {
    return { ...details, recovered: false, recoveryReason: 'same_process' };
  }
  if (isProcessAlive(details.pid)) {
    return { ...details, recovered: false, recoveryReason: 'pid_alive' };
  }
  const recoveryReason = 'pid_not_running';
  try {
    fs.rmSync(lockPath, { force: true });
    return { ...details, recovered: true, recoveryReason };
  } catch (err) {
    logger.warn({ err, lockPath }, 'Failed to remove stale IPC watcher lock');
    return { ...details, recovered: false, recoveryReason: 'remove_failed' };
  }
}

export function acquireIpcRootLock(ipcBaseDir: string): string {
  const lockPath = path.join(ipcBaseDir, '.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      startedAt: nowIso(),
    }),
    { flag: 'wx' },
  );
  return lockPath;
}
