import { describe, expect, it } from 'vitest';

import { deterministicBrowserKeepAliveMs } from '@core/jobs/deterministic-source-sync.js';

describe('deterministic managed browser keepalive', () => {
  it('keeps Chrome alive beyond the bounded source-sync action', () => {
    expect(deterministicBrowserKeepAliveMs(1_800_000)).toBe(1_860_000);
  });

  it('caps the browser lease at the deterministic action boundary plus cleanup grace', () => {
    expect(deterministicBrowserKeepAliveMs(7_200_000)).toBe(1_860_000);
  });

  it('keeps a short action alive long enough to reach terminal cleanup', () => {
    expect(deterministicBrowserKeepAliveMs(1_000)).toBe(70_000);
  });
});
