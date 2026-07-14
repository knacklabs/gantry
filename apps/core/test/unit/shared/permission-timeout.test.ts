import { describe, expect, it } from 'vitest';

import { getPermissionTimeoutMs } from '@core/shared/permission-timeout.js';
import { AUTO_PERMISSION_CLASSIFIER_WAIT_MS } from '@core/shared/permission-mode.js';

describe('permission-timeout', () => {
  it('leaves enough runner-side margin for the permission classifier', () => {
    expect(AUTO_PERMISSION_CLASSIFIER_WAIT_MS).toBe(20_000);
  });

  it('defaults interactive permission prompts to a human-scale timeout', () => {
    expect(getPermissionTimeoutMs('interactive', {}, {})).toBe(300_000);
  });

  it('defaults autonomous permission checks to no IPC wait', () => {
    expect(getPermissionTimeoutMs('autonomous', {}, {})).toBe(0);
  });

  it('supports separate interactive and autonomous timeout env overrides', () => {
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
        { GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS: '1000' },
        {},
      ),
    ).toBe(1_000);
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
