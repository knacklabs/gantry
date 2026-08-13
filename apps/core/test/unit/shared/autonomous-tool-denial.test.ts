import { describe, expect, it } from 'vitest';

import { isGrantableAutonomousToolRecovery } from '@core/shared/autonomous-tool-denial.js';

describe('isGrantableAutonomousToolRecovery', () => {
  it('recognizes request_access as grantable', () => {
    expect(
      isGrantableAutonomousToolRecovery(
        'request_access {"target":{"kind":"capability","id":"browser.use"}}',
      ),
    ).toBe(true);
  });

  it('treats instruction-only recovery as non-grantable', () => {
    expect(
      isGrantableAutonomousToolRecovery(
        'request_mcp_server {"serverName":"customer-records"}',
      ),
    ).toBe(false);
  });
});
