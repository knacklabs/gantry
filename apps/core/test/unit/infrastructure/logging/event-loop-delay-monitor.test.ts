import { expect, it } from 'vitest';

import { blockedEventLoopDelayMs } from '@core/infrastructure/logging/event-loop-delay-monitor.js';

it('reports the max delay only when the main thread was blocked over a second', () => {
  expect(blockedEventLoopDelayMs(20e6)).toBeNull();
  expect(blockedEventLoopDelayMs(1_000e6)).toBeNull();
  expect(blockedEventLoopDelayMs(1_250e6)).toBe(1_250);
});
