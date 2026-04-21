import os from 'os';
import path from 'path';

const DEFAULT_MYCLAW_HOME = path.join(os.homedir(), '.myclaw');

function expandHomePath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function getMyclawHome(raw?: string): string {
  const source =
    raw?.trim() || process.env.MYCLAW_HOME?.trim() || DEFAULT_MYCLAW_HOME;
  return path.resolve(expandHomePath(source));
}

export function getIpcDir(
  groupFolder: string,
  runtimeHome = getMyclawHome(),
): string {
  return path.resolve(runtimeHome, 'data', 'ipc', groupFolder);
}

export function getAgentDir(
  groupFolder: string,
  runtimeHome = getMyclawHome(),
): string {
  return path.resolve(runtimeHome, 'agents', groupFolder);
}

export function getStoreDbPath(runtimeHome = getMyclawHome()): string {
  return path.resolve(runtimeHome, 'store', 'messages.db');
}

export function getClaudeProjectDirName(cwd: string): string {
  return path.resolve(cwd).replace(/[\\/:\s]/g, '-');
}
