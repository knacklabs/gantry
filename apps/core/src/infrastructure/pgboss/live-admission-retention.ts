import { logger } from '../logging/logger.js';
import { toIso } from '../../shared/time/datetime.js';

export const LIVE_ADMISSION_TERMINAL_RETENTION_MS = 30 * 86_400_000;
export const LIVE_ADMISSION_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Runs the terminal-row retention sweep if the interval has elapsed and
 * returns the new last-sweep timestamp, or the unchanged one when the sweep
 * was skipped, failed, or only partially drained. A failed sweep must not
 * count as done (it would suppress retries for the full interval) nor abort
 * the caller's maintenance pass; a partial drain leaves the guard unlatched
 * so the next maintenance tick continues in bounded slices.
 */
export async function sweepTerminalLiveAdmissionsIfDue(input: {
  sweep?: (cutoffIso: string) => Promise<{ deleted: number; more: boolean }>;
  lastSweepAt: number | null;
  now: number;
}): Promise<number | null> {
  const { sweep, lastSweepAt, now } = input;
  if (!sweep) return lastSweepAt;
  if (
    lastSweepAt !== null &&
    now - lastSweepAt < LIVE_ADMISSION_RETENTION_SWEEP_INTERVAL_MS
  ) {
    return lastSweepAt;
  }
  try {
    const { more } = await sweep(
      toIso(now - LIVE_ADMISSION_TERMINAL_RETENTION_MS),
    );
    return more ? lastSweepAt : now;
  } catch (err) {
    logger.warn({ err }, 'Live-admission retention sweep failed');
    return lastSweepAt;
  }
}
