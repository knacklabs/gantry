import { describe, expect, it, vi } from 'vitest';

import {
  resolveAgentToolRuntimePolicy,
  validateAgentToolRuntimeRules,
} from '@core/application/agents/agent-tool-runtime-rules.js';
import { resolveAgentPromptCapabilityCatalog } from '@core/application/agents/agent-prompt-capability-catalog.js';
import { semanticCapabilityInputSchema } from '@core/shared/semantic-capabilities.js';

function patternToolRepository() {
  const tool = {
    id: 'tool:github-search-read',
    appId: 'app-one',
    name: 'capability:github.search.read',
    inputSchema: semanticCapabilityInputSchema({
      capabilityId: 'github.search.read',
      displayName: 'GitHub search read',
      category: 'mcp',
      risk: 'read',
      can: 'Search GitHub repositories.',
      cannot: 'Mutate GitHub state or call non-search tools.',
      credentialSource: 'none',
      implementationBindings: [
        {
          kind: 'mcp_pattern',
          mcpServer: 'github',
          mcpToolPatterns: ['search_*', 'get_repository'],
        },
      ],
    }),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return {
    listAgentToolBindings: async () => [
      {
        id: 'agent-tool-binding:github-search-read',
        appId: 'app-one',
        agentId: 'agent-one',
        toolId: tool.id,
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ],
    getTool: async (id: string) => (id === tool.id ? tool : null),
  } as never;
}

function legacyExactToolRepository() {
  const tool = {
    id: 'tool:github-search-read',
    appId: 'app-one',
    name: 'capability:github.search.read',
    inputSchema: semanticCapabilityInputSchema({
      capabilityId: 'github.search.read',
      displayName: 'GitHub search read',
      category: 'mcp',
      risk: 'read',
      can: 'Search GitHub repositories.',
      cannot: 'Mutate GitHub state.',
      credentialSource: 'none',
      implementationBindings: [
        {
          kind: 'mcp_tool',
          mcpTool: 'mcp__github__search_repositories',
        },
      ],
    }),
  };
  return {
    listAgentToolBindings: async () => [{ status: 'active', toolId: tool.id }],
    getTool: async () => tool,
  } as never;
}

describe('reviewed MCP pattern projection', () => {
  it('excludes selected skill actions whose backing skill is missing or disabled', async () => {
    const tool = {
      id: 'tool:skill-publish',
      appId: 'app-one',
      name: 'capability:skill.publisher.publish',
      inputSchema: semanticCapabilityInputSchema({
        capabilityId: 'skill.publisher.publish',
        displayName: 'Publisher publish',
        category: 'Publishing',
        risk: 'write',
        can: 'Publish prepared content.',
        cannot: 'Read unrelated credentials.',
        credentialSource: 'skill_secret',
        implementationBindings: [
          {
            kind: 'tool_rule',
            rule: 'RunCommand(skills/publisher/publish.py *)',
          },
        ],
        source: {
          kind: 'skill_action',
          skillId: 'skill:publisher',
          skillName: 'publisher',
          actionId: 'publish',
        },
      }),
    };
    const repository = {
      listAgentToolBindings: async () => [
        { status: 'active', toolId: tool.id },
      ],
      getTool: async () => tool,
    };

    for (const skillRepository of [
      undefined,
      { listEnabledSkillsForAgent: async () => [] },
    ]) {
      const policy = await resolveAgentToolRuntimePolicy({
        repository: repository as never,
        ...(skillRepository
          ? { skillRepository: skillRepository as never }
          : {}),
        appId: 'app-one',
        agentId: 'agent-one',
        errorSubject: 'Configured agent tool',
      });
      const catalog = await resolveAgentPromptCapabilityCatalog({
        appId: 'app-one',
        agentId: 'agent-one',
        readySemanticCapabilities: policy.semanticCapabilities,
      });

      expect(policy.semanticCapabilities).toEqual([]);
      expect(catalog.readyActions).toEqual([]);
    }
  });

  it('excludes missing definitions and independently disabled bindings from ready actions', async () => {
    const getTool = vi.fn(async (toolId: string) =>
      toolId === 'tool:disabled'
        ? {
            appId: 'app-one',
            name: 'capability:disabled.read',
            inputSchema: semanticCapabilityInputSchema({
              capabilityId: 'disabled.read',
              displayName: 'Disabled read',
              category: 'Test',
              risk: 'read',
              can: 'Read disabled data.',
              cannot: 'Write data.',
              credentialSource: 'none',
              implementationBindings: [{ kind: 'adapter', adapterRef: 'test' }],
            }),
          }
        : null,
    );
    const policy = await resolveAgentToolRuntimePolicy({
      repository: {
        listAgentToolBindings: async () => [
          { status: 'active', toolId: 'tool:missing' },
          { status: 'disabled', toolId: 'tool:disabled' },
        ],
        getTool,
      } as never,
      appId: 'app-one',
      agentId: 'agent-one',
      errorSubject: 'Configured agent tool',
    });
    const catalog = await resolveAgentPromptCapabilityCatalog({
      appId: 'app-one',
      agentId: 'agent-one',
      readySemanticCapabilities: policy.semanticCapabilities,
    });

    expect(getTool).toHaveBeenCalledTimes(1);
    expect(getTool).toHaveBeenCalledWith('tool:missing');
    expect(catalog.readyActions).toEqual([]);
  });

  it('projects pattern rules and mcp_server runtime access from the selected capability', async () => {
    const policy = await resolveAgentToolRuntimePolicy({
      repository: patternToolRepository(),
      appId: 'app-one',
      agentId: 'agent-one',
      errorSubject: 'Configured agent tool',
    });

    expect(policy.rules).toEqual([
      'capability:github.search.read',
      'mcp__github__search_*',
      'mcp__github__get_repository',
    ]);
    expect(policy.runtimeAccess).toEqual([
      {
        selectedCapabilityId: 'github.search.read',
        auditLabel: 'GitHub search read',
        sourceType: 'mcp_server',
        reviewedServerId: 'github',
        allowedTools: ['mcp__github__search_*', 'mcp__github__get_repository'],
        credentialRefs: [],
        networkHosts: [],
      },
    ]);
    // Read-risk pattern bindings feed the deterministic read-only gate.
    expect(policy.reviewedMcpReadBindings).toEqual([
      {
        capabilityId: 'github.search.read',
        toolPattern: 'mcp__github__search_*',
      },
      {
        capabilityId: 'github.search.read',
        toolPattern: 'mcp__github__get_repository',
      },
    ]);
  });

  it('accepts projected pattern rules only when third-party projections are allowed', () => {
    expect(() =>
      validateAgentToolRuntimeRules({
        rules: ['mcp__github__search_*'],
        errorSubject: 'Configured agent tool',
        allowProjectedThirdPartyMcpTools: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateAgentToolRuntimeRules({
        rules: ['mcp__github__search_*'],
        errorSubject: 'Configured agent tool',
      }),
    ).toThrow(/projected from a reviewed semantic capability/);
    // Full-server wildcards stay rejected even for projections.
    expect(() =>
      validateAgentToolRuntimeRules({
        rules: ['mcp__github__*'],
        errorSubject: 'Configured agent tool',
        allowProjectedThirdPartyMcpTools: true,
      }),
    ).toThrow();
  });

  it('rejects legacy exact MCP bindings instead of projecting action authority', async () => {
    await expect(
      resolveAgentToolRuntimePolicy({
        repository: legacyExactToolRepository(),
        appId: 'app-one',
        agentId: 'agent-one',
        errorSubject: 'Configured agent tool',
      }),
    ).rejects.toThrow(/reviewed capability definition/);
  });
});
