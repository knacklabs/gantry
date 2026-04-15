import fs from 'fs';
import path from 'path';

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
    fs.mkdirSync(dir, { recursive: true });
  }
}
