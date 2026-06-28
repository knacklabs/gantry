import path from 'path';
import { fileURLToPath } from 'url';

import { ensurePrivateDirSync } from '../shared/private-fs.js';
import { resolvePackageRootFromSourceDir } from '../platform/package-root.js';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const IPC_WORKSPACE_SUBDIRS = [
  'messages',
  'tasks',
  'input',
  'memory-requests',
  'memory-responses',
  'browser-requests',
  'browser-responses',
  'permission-requests',
  'permission-responses',
  'rich-interactions',
  'interaction-boundaries',
  'user-questions',
  'user-answers',
  'task-responses',
] as const;

export function getHostAgentRunnerDistDir(): string {
  const packageRoot = resolvePackageRootFromSourceDir(SOURCE_DIR);
  return path.join(packageRoot, 'dist', 'runner');
}

export function ensureWorkspaceIpcLayout(workspaceIpcDir: string): void {
  ensurePrivateDirSync(workspaceIpcDir);
  for (const subdir of IPC_WORKSPACE_SUBDIRS) {
    ensurePrivateDirSync(path.join(workspaceIpcDir, subdir));
  }
}
