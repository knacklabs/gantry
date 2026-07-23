import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';

export function releaseIpcRootLock(input: {
  lockPath: string | undefined;
  runnerControlPort: FilesystemRunnerControlPort | undefined;
  warn: (context: Record<string, unknown>, message: string) => void;
}): boolean {
  if (!input.lockPath) return false;
  try {
    input.runnerControlPort?.releaseRootLock(input.lockPath);
  } catch (err) {
    // prettier-ignore
    input.warn({ err, lockPath: input.lockPath }, 'Failed to release IPC lock');
  }
  return true;
}
