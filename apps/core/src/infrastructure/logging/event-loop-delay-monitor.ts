import { monitorEventLoopDelay } from 'node:perf_hooks';

import { logger } from './logger.js';

const WINDOW_MS = 10_000;
const BLOCKED_MS = 1_000;

/** The window's max delay in ms when the main thread was blocked, else null. */
export function blockedEventLoopDelayMs(maxDelayNs: number): number | null {
  const maxDelayMs = Math.round(maxDelayNs / 1e6);
  return maxDelayMs > BLOCKED_MS ? maxDelayMs : null;
}

export function startEventLoopDelayMonitor(): void {
  const histogram = monitorEventLoopDelay();
  histogram.enable();
  setInterval(() => {
    const maxDelayMs = blockedEventLoopDelayMs(histogram.max);
    histogram.reset();
    if (maxDelayMs !== null) {
      logger.warn(
        { maxDelayMs, windowMs: WINDOW_MS },
        'Runtime main thread was blocked',
      );
    }
  }, WINDOW_MS).unref();
}
