import { describe, expect, it } from 'vitest';

import { buildToolNetworkEnv } from '@core/shared/tool-network-env.js';

describe('tool network env', () => {
  it('projects standard proxy aliases through the Gantry egress gateway', () => {
    const env = buildToolNetworkEnv({
      proxyUrl: 'http://127.0.0.1:18080/',
      noProxy: {
        NO_PROXY: 'api.internal',
        no_proxy: 'registry.internal',
      },
    });

    expect(env).toMatchObject({
      HTTP_PROXY: 'http://127.0.0.1:18080/',
      HTTPS_PROXY: 'http://127.0.0.1:18080/',
      http_proxy: 'http://127.0.0.1:18080/',
      https_proxy: 'http://127.0.0.1:18080/',
      ALL_PROXY: 'http://127.0.0.1:18080/',
      all_proxy: 'http://127.0.0.1:18080/',
      GRPC_PROXY: 'http://127.0.0.1:18080/',
      grpc_proxy: 'http://127.0.0.1:18080/',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(env.NO_PROXY).toBe(env.no_proxy);
    expect(env.NO_PROXY.split(',')).toEqual(['127.0.0.1', 'localhost', '::1']);
  });
});
