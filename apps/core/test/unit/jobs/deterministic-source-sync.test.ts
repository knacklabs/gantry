import { describe, expect, it } from 'vitest';

import {
  deterministicBrowserKeepAliveMs,
  resolveReviewedPrivateNetworkHostMappings,
} from '@core/jobs/deterministic-source-sync.js';

describe('deterministic managed browser keepalive', () => {
  it('keeps Chrome alive beyond the bounded source-sync action', () => {
    expect(deterministicBrowserKeepAliveMs(1_800_000)).toBe(1_860_000);
  });

  it('supports a two-hour deterministic browser action plus cleanup grace', () => {
    expect(deterministicBrowserKeepAliveMs(7_200_000)).toBe(7_260_000);
  });

  it('caps the browser lease at the deterministic action boundary plus cleanup grace', () => {
    expect(deterministicBrowserKeepAliveMs(14_400_000)).toBe(7_260_000);
  });

  it('keeps a short action alive long enough to reach terminal cleanup', () => {
    expect(deterministicBrowserKeepAliveMs(1_000)).toBe(70_000);
  });
});

describe('reviewed deterministic skill private-network hosts', () => {
  it('pins an exact reviewed service-discovery host that resolves only privately', async () => {
    await expect(
      resolveReviewedPrivateNetworkHostMappings(
        ['frontend-mcp-service.ats-prod:3000', 'cutshort.io:443'],
        async (hostname) =>
          hostname === 'frontend-mcp-service.ats-prod'
            ? [{ address: '127.255.0.1', family: 4 }]
            : [{ address: '104.18.1.1', family: 4 }],
      ),
    ).resolves.toEqual([
      {
        authority: 'frontend-mcp-service.ats-prod:3000',
        connectHost: '127.255.0.1',
      },
    ]);
  });

  it('does not bypass validation for mixed public/private DNS answers', async () => {
    await expect(
      resolveReviewedPrivateNetworkHostMappings(
        ['api.example.com:443'],
        async () => [
          { address: '10.0.0.10', family: 4 },
          { address: '8.8.8.8', family: 4 },
        ],
      ),
    ).resolves.toEqual([]);
  });

  it('ignores undeclared or unresolvable targets', async () => {
    await expect(
      resolveReviewedPrivateNetworkHostMappings(
        ['https://frontend-mcp-service.ats-prod:3000/path', 'missing.test'],
        async () => {
          throw new Error('not found');
        },
      ),
    ).resolves.toEqual([]);
  });
});
