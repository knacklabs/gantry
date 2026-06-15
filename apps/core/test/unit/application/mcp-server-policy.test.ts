import { describe, expect, it } from 'vitest';

import { validateTransportConfig } from '@core/application/mcp/mcp-server-policy.js';

describe('validateTransportConfig', () => {
  it('allows loopback HTTP for same-host MCP servers', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://127.0.0.1:3030/mcp',
      }),
    ).not.toThrow();
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
  });
});
