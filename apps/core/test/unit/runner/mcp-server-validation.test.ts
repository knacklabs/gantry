import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertRequiredMcpServerReady,
  readExternalMcpServers,
} from '@core/adapters/llm/anthropic-claude-agent/runner/mcp-server-validation.js';

afterEach(() => vi.unstubAllEnvs());

describe('external MCP execution', () => {
  it('wraps stdio servers with the Gantry-owned audit proxy', () => {
    vi.stubEnv(
      'GANTRY_MCP_SERVERS_JSON',
      JSON.stringify({
        firecrawl: {
          type: 'stdio',
          command: '/tools/firecrawl-mcp',
          args: ['--safe'],
          env: { FIRECRAWL_API_KEY: 'secret' },
        },
      }),
    );

    const firecrawl = readExternalMcpServers().firecrawl as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(firecrawl.command).toBe(process.execPath);
    expect(firecrawl.args).toEqual([
      expect.stringContaining('audited-external-mcp-proxy.js'),
      'firecrawl',
      '/tools/firecrawl-mcp',
      '--safe',
    ]);
    expect(firecrawl.env.FIRECRAWL_API_KEY).toBe('secret');
  });
});

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

  it.each(['failed', 'needs-auth', 'disabled'])(
    'rejects the configured external MCP server status %s',
    (status) => {
      expect(() =>
        assertRequiredMcpServerReady({
          mcp_servers: [
            { name: 'gantry', status: 'connected' },
            { name: 'firecrawl', status },
          ],
        }),
      ).toThrow(`Required MCP server "firecrawl" is not ready: ${status}`);
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
