import path from 'path';

import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';

export function acquireIpcRootLockForWatcher(input: {
  runnerControlPort: FilesystemRunnerControlPort;
  warn: (context: Record<string, unknown>, message: string) => void;
}): string | undefined {
  try {
    return input.runnerControlPort.acquireRootLock();
  } catch (err) {
    const lockPath = path.join(input.runnerControlPort.baseDir, '.lock');
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
    if (code !== 'EEXIST') throw err;

    const recoveredLock = input.runnerControlPort.recoverRootLock(lockPath);
    if (!recoveredLock.recovered) {
      input.warn(
        {
          lockPath,
          holderPid: recoveredLock.pid,
          holderStartedAt: recoveredLock.startedAt,
          reason: recoveredLock.recoveryReason,
        },
        'IPC watcher lock already held, skipping start',
      );
      return undefined;
    }
    input.warn(
      {
        lockPath,
        holderPid: recoveredLock.pid,
        holderStartedAt: recoveredLock.startedAt,
        reason: recoveredLock.recoveryReason,
      },
      'Recovered stale IPC watcher lock; retrying start',
    );
    try {
      return input.runnerControlPort.acquireRootLock();
    } catch (retryErr) {
      const retryCode =
        retryErr && typeof retryErr === 'object' && 'code' in retryErr
          ? String((retryErr as { code?: string }).code)
          : '';
      if (retryCode !== 'EEXIST') throw retryErr;

      const retryDetails = input.runnerControlPort.readRootLock(lockPath);
      input.warn(
        {
          lockPath,
          holderPid: retryDetails.pid,
          holderStartedAt: retryDetails.startedAt,
          reason: 'reacquire_raced',
        },
        'IPC watcher lock already held, skipping start',
      );
      return undefined;
    }
  }
}
