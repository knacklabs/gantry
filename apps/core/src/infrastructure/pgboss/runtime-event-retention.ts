import { logger } from '../logging/logger.js';
import { toIso } from '../../shared/time/datetime.js';

export const RUNTIME_EVENT_RETENTION_MS = 30 * 86_400_000;
export const RUNTIME_EVENT_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

export async function sweepRuntimeEventsIfDue(input: {
  sweep?: (cutoffIso: string) => Promise<{ deleted: number; more: boolean }>;
  lastSweepAt: number | null;
  now: number;
}): Promise<number | null> {
  const { sweep, lastSweepAt, now } = input;
  if (!sweep) return lastSweepAt;
  if (
    lastSweepAt !== null &&
    now - lastSweepAt < RUNTIME_EVENT_RETENTION_SWEEP_INTERVAL_MS
  ) {
    return lastSweepAt;
  }
  try {
    const { more } = await sweep(toIso(now - RUNTIME_EVENT_RETENTION_MS));
    return more ? lastSweepAt : now;
  } catch (err) {
    logger.warn({ err }, 'Runtime-event retention sweep failed');
    return lastSweepAt;
  }
}
