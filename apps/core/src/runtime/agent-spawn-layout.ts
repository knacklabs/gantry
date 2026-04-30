import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { resolvePackageRootFromSourceDir } from '../platform/package-root.js';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const IPC_GROUP_SUBDIRS = [
  'messages',
  'tasks',
  'input',
  'memory-requests',
  'memory-responses',
  'browser-requests',
  'browser-responses',
  'permission-requests',
  'permission-responses',
  'interaction-boundaries',
  'user-questions',
  'user-answers',
  'task-responses',
] as const;

export function getHostAgentRunnerDistDir(): string {
  const packageRoot = resolvePackageRootFromSourceDir(SOURCE_DIR);
  return path.join(packageRoot, 'dist', 'runner');
}

export function ensureGroupIpcLayout(groupIpcDir: string): void {
  for (const subdir of IPC_GROUP_SUBDIRS) {
    fs.mkdirSync(path.join(groupIpcDir, subdir), { recursive: true });
  }
}
