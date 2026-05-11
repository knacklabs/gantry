import { describe, expect, it } from 'vitest';

import { resolveConfiguredAllowedTools } from '@core/runtime/configured-agent-tools.js';

describe('configured agent tools', () => {
  it('resolves namespaced permission-rule catalog rows to their SDK rule names', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:abc123',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'Bash(npm test)',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual(['Bash(npm test)']);
  });

  it('drops stale active bindings when the catalog row is unavailable', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:Bash',
        },
      ],
      getTool: async () => null,
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual([]);
  });

  it('fails closed for stale active raw browser action MCP bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:browser',
        },
        {
          status: 'active',
          toolId: 'tool:Read',
        },
      ],
      getTool: async (toolId: string) =>
        toolId === 'tool:Read'
          ? { appId: 'default', name: 'Read' }
          : { appId: 'default', name: 'mcp__agent_browser__*' },
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('Raw browser backend MCP tools are host-private');
  });

  it('fails closed for stale active projected browser MCP bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:browser-projected',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'mcp__myclaw__browser_click',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('runtime projections, not durable capabilities');
  });

  it('drops bindings whose catalog row belongs to a different app', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:Browser',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'Browser',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'app:one',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual([]);
  });
});
