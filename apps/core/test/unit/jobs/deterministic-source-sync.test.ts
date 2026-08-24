import { describe, expect, it } from 'vitest';

import {
  deterministicBrowserKeepAliveMs,
  deterministicSkillServiceHostsFromEnv,
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
  it('projects an exact service URL only from reviewed required environment', () => {
    expect(
      deterministicSkillServiceHostsFromEnv(
        [{ requiredEnvVars: ['INTERNAL_API_URL', 'OPAQUE_API_KEY'] }],
        {
          INTERNAL_API_URL: 'http://frontend-mcp-service.ats-prod:3000/api',
          OPAQUE_API_KEY: 'not-a-url',
          UNREVIEWED_URL: 'http://admin.internal:8080',
        },
      ),
    ).toEqual(['frontend-mcp-service.ats-prod:3000']);
  });

  it('rejects credential-bearing and non-http service URLs', () => {
    expect(
      deterministicSkillServiceHostsFromEnv(
        [
          {
            requiredEnvVars: ['CREDENTIAL_URL', 'FILE_URL', 'HTTPS_URL'],
          },
        ],
        {
          CREDENTIAL_URL: 'http://configured-user@private.example:3000',
          FILE_URL: 'file:///srv/private',
          HTTPS_URL: 'https://api.example.test/v1',
        },
      ),
    ).toEqual(['api.example.test:443']);
  });

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
