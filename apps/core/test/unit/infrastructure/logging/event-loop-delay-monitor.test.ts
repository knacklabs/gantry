import { afterEach, expect, it, vi } from 'vitest';

import { startEventLoopDelayMonitor } from '@core/infrastructure/logging/event-loop-delay-monitor.js';
import { logger } from '@core/infrastructure/logging/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it('warns with the max delay when the main thread is blocked past the threshold', async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const stop = startEventLoopDelayMonitor({ windowMs: 50, blockedMs: 100 });
  try {
    // Let the monitor take its first sample before the block.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const blockedUntil = Date.now() + 300;
    while (Date.now() < blockedUntil) {
      // Busy-wait so no timer can run.
    }
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        { maxDelayMs: expect.any(Number), windowMs: 50 },
        'Runtime main thread was blocked',
      ),
    );
    const [meta] = warn.mock.calls[0] as unknown as [{ maxDelayMs: number }];
    expect(meta.maxDelayMs).toBeGreaterThan(100);
  } finally {
    stop();
  }
});
