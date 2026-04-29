import { describe, expect, it, vi } from 'vitest';

const requestBrowserAction = vi.hoisted(() => vi.fn());

vi.mock('@core/runner/mcp/ipc.js', () => ({
  requestBrowserAction,
}));

vi.mock('@core/runner/mcp/formatting.js', () => ({
  formatBrowserToolResponse: (response: unknown) => JSON.stringify(response),
}));

import { registerBrowserTools } from '@core/runner/mcp/tools/browser.js';

class TestMcpServer {
  readonly tools = new Map<string, (args: unknown) => Promise<unknown>>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: (args: unknown) => Promise<unknown>,
  ) {
    this.tools.set(name, handler);
  }
}

describe('runner browser MCP lifecycle tools', () => {
  it('delegates browser status to signed IPC without direct CDP probing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    requestBrowserAction.mockResolvedValueOnce({
      ok: true,
      data: {
        profile: 'myclaw',
        profileName: 'myclaw',
        running: true,
        cdpReady: true,
        port: 4567,
      },
    });
    const server = new TestMcpServer();
    registerBrowserTools(server as never);

    const result = await server.tools.get('browser_status')?.({
      profile_name: 'myclaw',
    });

    expect(requestBrowserAction).toHaveBeenCalledWith('browser_status', {
      profile_name: 'myclaw',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            data: {
              profile: 'myclaw',
              profileName: 'myclaw',
              running: true,
              cdpReady: true,
              port: 4567,
            },
          }),
        },
      ],
    });
    vi.unstubAllGlobals();
  });
});
