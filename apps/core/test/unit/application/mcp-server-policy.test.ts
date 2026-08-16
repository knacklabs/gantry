import { describe, expect, it } from 'vitest';

import {
  normalizeMcpNetworkHosts,
  validateTransportConfig,
} from '@core/application/mcp/mcp-server-policy.js';

describe('validateTransportConfig', () => {
  it('allows loopback HTTP for same-host MCP servers', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://127.0.0.1:3030/mcp',
      }),
    ).not.toThrow();

    expect(
      normalizeMcpNetworkHosts({
        serverName: 'local',
        networkHosts: ['127.0.0.1:3030'],
        config: { transport: 'http', url: 'http://127.0.0.1:3030/mcp' },
      }),
    ).toEqual(['127.0.0.1:3030']);
  });

  it('keeps non-loopback HTTP and private HTTPS MCP targets rejected', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://10.0.0.10:3030/mcp',
      }),
    ).toThrow(/https unless it targets a loopback IP/);

    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'https://127.0.0.1:3030/mcp',
      }),
    ).toThrow(/private, loopback/);

    expect(() =>
      normalizeMcpNetworkHosts({
        serverName: 'local',
        networkHosts: ['127.0.0.1:4040'],
        config: { transport: 'http', url: 'http://127.0.0.1:3030/mcp' },
      }),
    ).toThrow(/private, loopback/);
  });
});
