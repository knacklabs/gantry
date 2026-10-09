import { monitorEventLoopDelay } from 'node:perf_hooks';

import { logger } from './logger.js';

/** Warns when the main thread was blocked over `blockedMs` in a window. */
export function startEventLoopDelayMonitor({
  windowMs = 10_000,
  blockedMs = 1_000,
} = {}): () => void {
  const histogram = monitorEventLoopDelay();
  histogram.enable();
  const timer = setInterval(() => {
    const maxDelayMs = Math.round(histogram.max / 1e6);
    histogram.reset();
    if (maxDelayMs > blockedMs) {
      logger.warn({ maxDelayMs, windowMs }, 'Runtime main thread was blocked');
    }
  }, windowMs).unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
