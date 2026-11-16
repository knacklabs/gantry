import { describe, expect, it } from 'vitest';

import {
  buildToolNetworkEnv,
  projectSandboxToolNetworkEnv,
} from '@core/shared/tool-network-env.js';

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

describe('sandbox tool proxy projection', () => {
  it('uses the namespace-local proxy without leaking runner secrets or bypassing the gateway', () => {
    const outer = buildToolNetworkEnv({ proxyUrl: 'http://127.0.0.1:19620/' });
    const runtime = {
      GANTRY_SANDBOX_RUNTIME_PROXY: '1',
      HTTP_PROXY: 'http://localhost:3128',
      HTTPS_PROXY: 'http://localhost:3128',
      ALL_PROXY: 'socks5h://localhost:3129',
      GANTRY_IPC_AUTH_TOKEN: 'must-not-leak',
      NO_PROXY: '*',
    };
    const projected = projectSandboxToolNetworkEnv(outer, runtime);
    expect(projected).toMatchObject({
      HTTP_PROXY: 'http://localhost:3128',
      HTTPS_PROXY: 'http://localhost:3128',
      http_proxy: 'http://localhost:3128',
      https_proxy: 'http://localhost:3128',
      ALL_PROXY: 'socks5h://localhost:3129',
      GRPC_PROXY: 'socks5h://localhost:3129',
      NO_PROXY: '',
      no_proxy: '',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(projected.GANTRY_IPC_AUTH_TOKEN).toBeUndefined();
    expect(outer.HTTP_PROXY).toBe('http://127.0.0.1:19620/');
  });
  it('preserves configured tool networking outside sandbox-runtime mode', () => {
    const outer = buildToolNetworkEnv({ proxyUrl: 'http://127.0.0.1:19620/' });
    expect(projectSandboxToolNetworkEnv(outer, {})).toEqual(outer);
  });
  it('fails closed when the sandbox bridge has no HTTP proxy', () => {
    expect(() =>
      projectSandboxToolNetworkEnv({}, { GANTRY_SANDBOX_RUNTIME_PROXY: '1' }),
    ).toThrow('proxy');
  });
});
