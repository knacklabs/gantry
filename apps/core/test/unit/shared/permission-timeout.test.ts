import { describe, expect, it } from 'vitest';

import {
  getPermissionTimeoutMs,
  NO_PERMISSION_TIMEOUT_MS,
} from '@core/shared/permission-timeout.js';

describe('permission-timeout', () => {
  it('defaults interactive permission prompts to no timeout', () => {
    expect(getPermissionTimeoutMs('interactive', {}, {})).toBe(
      NO_PERMISSION_TIMEOUT_MS,
    );
  });

  it('defaults autonomous permission prompts to the shared no-timeout policy', () => {
    expect(getPermissionTimeoutMs('autonomous', {}, {})).toBe(
      NO_PERMISSION_TIMEOUT_MS,
    );
  });

  it('uses one timeout configuration for interactive and autonomous prompts', () => {
    expect(
      getPermissionTimeoutMs(
        'interactive',
        { GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS: '20000' },
        {},
      ),
    ).toBe(20_000);
    expect(
      getPermissionTimeoutMs(
        'autonomous',
        {
          GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS: '1000',
          GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS: '20000',
        },
        {},
      ),
    ).toBe(20_000);
  });

  it('preserves the explicit interactive no-timeout sentinel', () => {
    expect(
      getPermissionTimeoutMs(
        'interactive',
        { GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS: '0' },
        {},
      ),
    ).toBe(NO_PERMISSION_TIMEOUT_MS);
  });

  it('uses runtime env fallback when process env is unset', () => {
    expect(
      getPermissionTimeoutMs(
        'interactive',
        {},
        { GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS: '17000' },
      ),
    ).toBe(17_000);
  });
});
