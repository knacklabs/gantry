import path from 'path';

import { DATA_DIR, AGENTS_DIR } from '../config/index.js';
import { isValidWorkspaceFolder } from './workspace-folder-rules.js';

export { isValidWorkspaceFolder } from './workspace-folder-rules.js';

function assertValidWorkspaceFolder(folder: string): void {
  if (!isValidWorkspaceFolder(folder)) {
    throw new Error(`Invalid workspace folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveWorkspaceFolderPath(folder: string): string {
  assertValidWorkspaceFolder(folder);
  const nextWorkspacePath = path.resolve(AGENTS_DIR, folder);
  ensureWithinBase(AGENTS_DIR, nextWorkspacePath);
  return nextWorkspacePath;
}

export function resolveWorkspaceIpcPath(folder: string): string {
  assertValidWorkspaceFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
