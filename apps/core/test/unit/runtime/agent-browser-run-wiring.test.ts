import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockEnsureBrowserReady = vi.hoisted(() => vi.fn());

vi.mock('@core/runtime/browser-capability.js', () => ({
  DEFAULT_BROWSER_PROFILE_NAME: 'myclaw',
  ensureBrowserReady: (...args: unknown[]) => mockEnsureBrowserReady(...args),
}));

import { createAgentBrowserRunWiring } from '@core/runtime/agent-browser-run-wiring.js';

const browserSkillSource = {
  listSkills: async () => [
    {
      id: 'agent-browser',
      sourceType: 'runtime',
      enabled: true,
    },
  ],
};

const adapters = {
  browserSkillSource,
  actionMcpServerName: 'agent_browser',
  createActionMcpServerConfig: (cdpEndpoint: string) => ({
    command: process.execPath,
    args: [
      '/tmp/playwright-mcp',
      '--cdp-endpoint',
      cdpEndpoint,
      '--shared-browser-context',
    ],
    env: {
      PLAYWRIGHT_MCP_CDP_ENDPOINT: cdpEndpoint,
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    },
  }),
};

describe('agent browser run wiring', () => {
  beforeEach(() => {
    mockEnsureBrowserReady.mockReset();
    mockEnsureBrowserReady.mockResolvedValue({
      profile: 'myclaw',
      profileName: 'myclaw',
      running: true,
      cdpReady: true,
      port: 4567,
    });
  });

  it('returns empty projections for non-main agents', async () => {
    const wiring = createAgentBrowserRunWiring({ isMain: false }, adapters);
    const projection = await wiring.activate();

    expect(wiring.skillSources).toEqual([]);
    expect(projection).toEqual({
      env: {},
      mcpCapabilities: [],
      runtimeDetails: [],
    });
    expect(mockEnsureBrowserReady).not.toHaveBeenCalled();
  });

  it('exposes the runtime-installed browser skill for the main agent', async () => {
    const wiring = createAgentBrowserRunWiring({ isMain: true }, adapters);

    expect(wiring.skillSources).toHaveLength(1);
    await expect(wiring.skillSources[0]?.listSkills()).resolves.toMatchObject([
      {
        id: 'agent-browser',
        sourceType: 'runtime',
        enabled: true,
      },
    ]);
  });

  it('launches headed Chrome and returns browser action MCP projection', async () => {
    const wiring = createAgentBrowserRunWiring({ isMain: true }, adapters);

    const projection = await wiring.activate();

    expect(mockEnsureBrowserReady).toHaveBeenCalledWith({
      profileName: 'myclaw',
      headless: undefined,
    });
    expect(projection.env).toMatchObject({
      PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:4567',
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    });
    expect(projection.mcpCapabilities).toHaveLength(1);
    expect(projection.mcpCapabilities[0]).toMatchObject({
      name: 'agent_browser',
      allowedToolNames: ['mcp__agent_browser__*'],
      autoApproveToolNames: [],
      required: false,
      config: {
        command: process.execPath,
        args: expect.arrayContaining([
          '--cdp-endpoint',
          'http://127.0.0.1:4567',
          '--shared-browser-context',
        ]),
        env: {
          PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:4567',
          NO_PROXY: '127.0.0.1,localhost,::1',
          no_proxy: '127.0.0.1,localhost,::1',
        },
      },
    });
    expect(projection.runtimeDetails).toEqual(
      expect.arrayContaining([
        'browserProfile=myclaw',
        'browserCdp=http://127.0.0.1:4567',
        'browserHeadless=false',
      ]),
    );
  });

  it('passes explicit headless mode only when requested', async () => {
    const wiring = createAgentBrowserRunWiring(
      {
        isMain: true,
        headless: true,
      },
      adapters,
    );

    await wiring.activate();

    expect(mockEnsureBrowserReady).toHaveBeenCalledWith({
      profileName: 'myclaw',
      headless: true,
    });
  });
});
