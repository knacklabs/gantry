import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { nowIso, nowMs } from '../shared/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../shared/private-fs.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import { IPC_WORKSPACE_SUBDIRS } from './agent-spawn-layout.js';

const IPC_ERROR_ARCHIVE_TTL_MS = 30 * 24 * 60 * 60_000;
const IPC_ERROR_ARCHIVE_SWEEP_INTERVAL_MS = 60_000;
const IPC_ERROR_ARCHIVE_MAX_ENTRIES = 500;
const IPC_ERROR_ARCHIVE_NAME_MAX_BYTES = 255;
const IPC_ERROR_ARCHIVE_NAME_PATTERN =
  /^(\d+)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-.+$/i;
let lastIpcErrorArchiveSweepAt = 0;
let ipcErrorArchivesSinceLastCompletedSweep = 0;

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

export function ensureWorkspaceIpcLayout(
  ipcBaseDir: string,
  workspaceFolder: string,
): void {
  const workspaceDir = path.join(ipcBaseDir, workspaceFolder);
  ensurePrivateDirSync(workspaceDir);
  for (const subdir of IPC_WORKSPACE_SUBDIRS) {
    ensurePrivateDirSync(path.join(workspaceDir, subdir));
  }
}

export function hasCompleteTrustedWorkspaceIpcLayout(
  ipcBaseDir: string,
  workspaceFolder: string,
): boolean {
  const workspaceDir = path.join(ipcBaseDir, workspaceFolder);
  if (!isTrustedDirectory(workspaceDir)) return false;
  for (const subdir of IPC_WORKSPACE_SUBDIRS) {
    if (!isTrustedDirectory(path.join(workspaceDir, subdir))) return false;
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
    `.processing-${process.pid}-${nowMs()}-${randomUUID()}-${path.basename(filePath)}`,
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
  lane = path.basename(path.dirname(claimedPath)),
): void {
  const errorDir = path.join(ipcBaseDir, 'errors');
  ensurePrivateDirSync(errorDir);
  try {
    fs.renameSync(claimedPath, path.join(errorDir, archiveFilename()));
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
    if (code !== 'ENOENT') {
      throw err;
    }
    return;
  }
  ipcErrorArchivesSinceLastCompletedSweep += 1;

  try {
    pruneExpiredIpcErrorArchives(errorDir);
  } catch (err) {
    logger.warn({ err, errorDir }, 'Failed to prune IPC error archives');
  }

  function archiveFilename(): string {
    const prefix = `${nowMs()}-${randomUUID()}-`;
    const tail = Buffer.from(
      `${sourceAgentFolder}-${lane}-${path.basename(filename)}`,
    );
    let tailEnd = Math.min(
      tail.length,
      IPC_ERROR_ARCHIVE_NAME_MAX_BYTES - Buffer.byteLength(prefix),
    );
    while (tailEnd > 0 && (tail[tailEnd]! & 0xc0) === 0x80) tailEnd -= 1;
    return `${prefix}${tail.subarray(0, tailEnd).toString('utf8')}`;
  }
}

function pruneExpiredIpcErrorArchives(errorDir: string): void {
  const sweptAt = nowMs();
  if (
    ipcErrorArchivesSinceLastCompletedSweep < IPC_ERROR_ARCHIVE_MAX_ENTRIES &&
    sweptAt - lastIpcErrorArchiveSweepAt < IPC_ERROR_ARCHIVE_SWEEP_INTERVAL_MS
  ) {
    return;
  }
  lastIpcErrorArchiveSweepAt = sweptAt;

  const cutoff = sweptAt - IPC_ERROR_ARCHIVE_TTL_MS;
  const retainedArchives: Array<{ archivedAt: number; name: string }> = [];
  for (const entry of fs.readdirSync(errorDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = IPC_ERROR_ARCHIVE_NAME_PATTERN.exec(entry.name);
    if (!match) continue;
    const archivedAt = Number(match[1]);
    if (archivedAt >= cutoff) {
      retainedArchives.push({ archivedAt, name: entry.name });
      continue;
    }
    removeArchive(entry.name);
  }

  retainedArchives.sort(
    (left, right) =>
      left.archivedAt - right.archivedAt || left.name.localeCompare(right.name),
  );
  const excess = retainedArchives.length - IPC_ERROR_ARCHIVE_MAX_ENTRIES;
  for (const archive of retainedArchives.slice(0, Math.max(0, excess))) {
    removeArchive(archive.name);
  }
  ipcErrorArchivesSinceLastCompletedSweep = Math.min(
    retainedArchives.length,
    IPC_ERROR_ARCHIVE_MAX_ENTRIES,
  );

  function removeArchive(name: string): void {
    try {
      fs.rmSync(path.join(errorDir, name));
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: string }).code)
          : '';
      if (code !== 'ENOENT') throw err;
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
  writePrivateFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      startedAt: nowIso(),
    }),
    { flag: 'wx' },
  );
  return lockPath;
}
