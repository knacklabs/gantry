import { describe, expect, it } from 'vitest';

import {
  SANDBOX_RUNTIME_MODEL_GATEWAY_HOST,
  loopbackAuthorityFromUrl,
  projectSandboxRuntimeModelGatewayEnv,
} from '@core/runtime/agent-spawn-runtime-policy.js';

describe('agent spawn runtime policy', () => {
  const envKey = (suffix: string) => ['ANTHROPIC', suffix].join('_');

  it('normalizes IPv6 loopback model gateway authorities', () => {
    expect(loopbackAuthorityFromUrl('http://[::1]:4567/anthropic')).toBe(
      '[::1]:4567',
    );
  });

  it('rewrites loopback model gateway env to a sandbox proxy-visible alias', () => {
    const projection = projectSandboxRuntimeModelGatewayEnv({
      [envKey('BASE_URL')]: 'http://127.0.0.1:4567/anthropic',
      [envKey('API_KEY')]: 'gtw_test',
    });

    expect(projection.modelCredentialEnv).toMatchObject({
      [envKey('BASE_URL')]:
        `http://${SANDBOX_RUNTIME_MODEL_GATEWAY_HOST}:4567/anthropic`,
      [envKey('API_KEY')]: 'gtw_test',
    });
    expect(projection.allowedNetworkHosts).toEqual([
      `${SANDBOX_RUNTIME_MODEL_GATEWAY_HOST}:4567`,
    ]);
    expect(projection.privateNetworkHostMappings).toEqual([
      {
        authority: `${SANDBOX_RUNTIME_MODEL_GATEWAY_HOST}:4567`,
        connectHost: '127.0.0.1',
      },
    ]);
  });
});
