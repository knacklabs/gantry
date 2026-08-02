import { describe, expect, it } from 'vitest';

import { requestOnlyCapabilityPendingKey } from '@core/jobs/request-only-capability-dedupe.js';

describe('request-only capability review dedupe', () => {
  it('keeps provider account identity in the pending review key', () => {
    const common = {
      sourceAgentFolder: 'main_agent',
      targetJid: 'sl:C123',
      review: {
        toolName: 'request_permission',
        toolInput: { capabilityId: 'mcp.sum.read' },
      },
    };

    const primary = requestOnlyCapabilityPendingKey({
      ...common,
      data: { appId: 'app:test', providerAccountId: 'slack_primary' },
    });
    const secondary = requestOnlyCapabilityPendingKey({
      ...common,
      data: { appId: 'app:test', providerAccountId: 'slack_secondary' },
    });

    expect(primary).not.toBe(secondary);
  });
});
