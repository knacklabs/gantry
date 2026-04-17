import { describe, expect, it } from 'vitest';

import { startSessionCleanup } from '@core/session/session-cleanup.js';

describe('session-cleanup', () => {
  it('is a no-op and does not throw', () => {
    expect(() => startSessionCleanup()).not.toThrow();
  });
});
