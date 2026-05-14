import { describe, expect, it } from 'vitest';

import {
  SDK_SANDBOX_NETWORK_ACCESS_REJECTION_REASON,
  validateReadableAgentToolRule,
} from '@core/shared/agent-tool-references.js';

describe('agent tool references', () => {
  it('rejects durable SDK sandbox network access rules', () => {
    expect(validateReadableAgentToolRule('SandboxNetworkAccess')).toEqual({
      ok: false,
      reason: SDK_SANDBOX_NETWORK_ACCESS_REJECTION_REASON,
    });
    expect(validateReadableAgentToolRule('SandboxNetworkAccess(*)')).toEqual({
      ok: false,
      reason: SDK_SANDBOX_NETWORK_ACCESS_REJECTION_REASON,
    });
  });
});
