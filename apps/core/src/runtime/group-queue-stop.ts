import { ChildProcess } from 'child_process';

import { logger } from '../infrastructure/logging/logger.js';

export const ACTIVE_RUN_STOP_REQUESTED = Symbol.for(
  'myclaw.activeRunStopRequested',
);

interface StopActiveGroupRunOptions {
  groupJid: string;
  targetQueueJid: string;
  proc: ChildProcess;
  closeStdin: () => void;
}

export function stopActiveGroupRun({
  groupJid,
  targetQueueJid,
  proc,
  closeStdin,
}: StopActiveGroupRunOptions): boolean {
  closeStdin();
  markActiveRunStopRequested(proc);

  const pid = proc.pid;
  if (typeof pid !== 'number' || pid <= 0) {
    try {
      proc.kill('SIGTERM');
      logger.warn(
        { groupJid, targetQueueJid },
        'Stop requested for active run (SIGTERM)',
      );
      return true;
    } catch (err) {
      logger.warn(
        { groupJid, targetQueueJid, err },
        'Failed to stop active run (missing pid)',
      );
      return false;
    }
  }

  try {
    process.kill(-pid, 'SIGTERM');
    logger.warn(
      { groupJid, targetQueueJid, pid },
      'Stop requested for active run (SIGTERM process group)',
    );
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      logger.warn(
        { groupJid, targetQueueJid, pid },
        'Stop requested for active run (SIGTERM process)',
      );
      return true;
    } catch (err) {
      logger.warn(
        { groupJid, targetQueueJid, pid, err },
        'Failed to stop active run (SIGTERM)',
      );
      return false;
    }
  }
}

export function activeRunStopWasRequested(proc: ChildProcess): boolean {
  return (
    (proc as { [ACTIVE_RUN_STOP_REQUESTED]?: boolean })[
      ACTIVE_RUN_STOP_REQUESTED
    ] === true
  );
}

function markActiveRunStopRequested(proc: ChildProcess): void {
  (proc as { [ACTIVE_RUN_STOP_REQUESTED]?: boolean })[
    ACTIVE_RUN_STOP_REQUESTED
  ] = true;
}
