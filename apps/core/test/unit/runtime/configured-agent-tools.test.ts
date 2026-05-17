import { describe, expect, it } from 'vitest';

import { resolveConfiguredAllowedTools } from '@core/runtime/configured-agent-tools.js';

describe('configured agent tools', () => {
  it('resolves namespaced permission-rule catalog rows to scoped Bash rules', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:abc123',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'Bash(npm test *)',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual(['Bash(npm test *)']);
  });

  it('keeps provider-neutral semantic capabilities provider-neutral at runtime', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:capability:google.sheets.write',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'capability:google.sheets.write',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual(['capability:google.sheets.write']);
  });

  it('does not expand user-defined local CLI drafts to runnable Bash rules', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:capability:acme.invoices.read',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'capability:acme.invoices.read',
        inputSchema: {
          format: 'myclaw.semantic-capability.v1',
          schema: {
            capabilityId: 'acme.invoices.read',
            displayName: 'Acme invoices read',
            category: 'Acme',
            risk: 'read',
            can: 'Read invoice records.',
            cannot: 'Write invoices or export tokens.',
            credentialSource: 'local_cli',
            implementationBindings: [
              {
                kind: 'local_cli',
                executablePath: '/usr/local/bin/acme',
                executableVersion: '1.2.3',
                executableHash: 'sha256:abc123',
                commandTemplates: ['/usr/local/bin/acme invoices read *'],
                authPreflightCommand: '/usr/local/bin/acme auth status',
              },
            ],
            protectedPaths: ['~/.config/acme'],
          },
        },
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual(['capability:acme.invoices.read']);
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
          : {
              appId: 'default',
              name: 'mcp__browser' + '_' + 'backend' + '__*',
            },
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('Host-private browser backend tools');
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
        name: 'mcp__myclaw__browser_act',
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

  it('fails closed for stale active MyClaw MCP wildcard bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:myclaw-wildcard',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'mcp__myclaw__*',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('wildcard grants are not supported');
  });

  it('fails closed for stale active Bash wildcard bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:bash-wildcard',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'Bash(*)',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('Persistent Bash scope is too broad');
  });

  it('fails closed for stale active SDK sandbox network bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:sandbox-network',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'SandboxNetworkAccess',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('SDK sandbox network prompts are internal');
  });

  it('fails closed for stale active third-party MCP wildcard bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:mcp-wildcard',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'mcp__github__*',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('request the MCP server capability');
  });

  it('fails closed for stale active exact third-party MCP tool bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:mcp-github-search',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'mcp__github__search_repositories',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('request and bind the MCP server capability');
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
