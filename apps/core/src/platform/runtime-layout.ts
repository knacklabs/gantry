import fs from 'fs';
import path from 'path';

import { ensureRuntimeClaudeFiles } from './claude-runtime-files.js';

export interface RuntimeLayoutPaths {
  runtimeHome: string;
  storeDir: string;
  agentsDir: string;
  dataDir: string;
  logsDir: string;
}

export function getRuntimeLayoutPaths(runtimeHome: string): RuntimeLayoutPaths {
  const root = path.resolve(runtimeHome);
  return {
    runtimeHome: root,
    storeDir: path.join(root, 'store'),
    agentsDir: path.join(root, 'agents'),
    dataDir: path.join(root, 'data'),
    logsDir: path.join(root, 'logs'),
  };
}

export function ensureRuntimeLayoutDirectories(runtimeHome: string): void {
  const paths = getRuntimeLayoutPaths(runtimeHome);
  const dirs = [
    paths.runtimeHome,
    paths.storeDir,
    paths.agentsDir,
    paths.dataDir,
    paths.logsDir,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort: some filesystems do not support POSIX modes.
    }
  }
  ensureRuntimeClaudeFiles(paths.runtimeHome);
}
