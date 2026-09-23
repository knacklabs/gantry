import { describe, expect, it } from 'vitest';

import {
  MCP_PROXY_WAIT_MS,
  resolveExternalCapabilityCallWaitMs,
} from '@core/runner/mcp/tools/service-constants.js';

describe('resolveExternalCapabilityCallWaitMs', () => {
  it('uses the projected hosted-capability wait', () => {
    expect(resolveExternalCapabilityCallWaitMs('1815000')).toBe(1_815_000);
    expect(resolveExternalCapabilityCallWaitMs('45000')).toBe(45_000);
  });

  it.each([undefined, '', 'not-a-number', '14999', '2147483648'])(
    'falls back to the ordinary proxy wait for invalid value %s',
    (raw) => {
      expect(resolveExternalCapabilityCallWaitMs(raw)).toBe(MCP_PROXY_WAIT_MS);
    },
  );
});
