import { describe, expect, it } from 'vitest';

import { assertRequiredMcpServerReady } from '@core/adapters/llm/anthropic-claude-agent/runner/mcp-server-validation.js';

describe('required Gantry MCP server readiness', () => {
  it('accepts a connected server', () => {
    expect(() =>
      assertRequiredMcpServerReady({
        mcp_servers: [{ name: 'gantry', status: 'connected' }],
      }),
    ).not.toThrow();
  });

  it('rejects an init snapshot without the Gantry server', () => {
    expect(() =>
      assertRequiredMcpServerReady({
        mcp_servers: [{ name: 'other', status: 'connected' }],
      }),
    ).toThrow('Required Gantry MCP server is missing from Claude init');
  });

  it('rejects an init snapshot without an MCP server array', () => {
    expect(() =>
      assertRequiredMcpServerReady({ mcp_servers: 'not-an-array' }),
    ).toThrow('Required Gantry MCP server status is missing from Claude init');
  });

  it.each(['failed', 'needs-auth', 'disabled'])(
    'rejects the terminal server status %s',
    (status) => {
      expect(() =>
        assertRequiredMcpServerReady({
          mcp_servers: [{ name: 'gantry', status }],
        }),
      ).toThrow(`Required Gantry MCP server is not ready: ${status}`);
    },
  );

  it.each(['pending', 'connecting', 'future-status'])(
    'tolerates the non-terminal server status %s at the Claude init snapshot',
    (status) => {
      expect(() =>
        assertRequiredMcpServerReady({
          mcp_servers: [{ name: 'gantry', status }],
        }),
      ).not.toThrow();
    },
  );
});
