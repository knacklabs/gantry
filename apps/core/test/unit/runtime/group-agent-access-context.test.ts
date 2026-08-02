import { describe, expect, it, vi } from 'vitest';

import { resolveGroupAgentAccessContext } from '@core/runtime/group-agent-access-context.js';
import { buildProviderSessionAccessFingerprint } from '@core/runtime/provider-session-access-fingerprint.js';
import { resolveAgentPromptCapabilityCatalog } from '@core/application/agents/agent-prompt-capability-catalog.js';
import type {
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '@core/domain/ports/repositories.js';
import type { GroupProcessingDeps } from '@core/runtime/group-processing-types.js';
import {
  semanticCapabilityInputSchema,
  type SemanticCapabilityDefinition,
} from '@core/shared/semantic-capabilities.js';

const NOW = '2026-07-27T00:00:00.000Z';
const APP_ID = 'app:lat-2';
const AGENT_ID = 'agent:lat-2';

describe('resolveGroupAgentAccessContext', () => {
  it('keeps access projections value-equivalent while using one snapshot read per surface', async () => {
    const readyAction = semanticCapability({
      capabilityId: 'crm.records.read',
      displayName: 'CRM records',
      can: 'Read approved CRM records.',
      category: 'crm',
    });
    const broadInventoryAction = semanticCapability({
      capabilityId: 'analytics.query',
      displayName: 'Analytics query',
      can: 'Query app-wide analytics inventory.',
      category: 'analytics',
    });
    const selectedSkill = skill({
      id: 'skill:release-writer',
      name: 'release-writer',
      description: 'Draft release notes from approved context.',
      actionPermissions: [
        {
          id: 'publish',
          capabilityId: 'skill.release.publish',
          displayName: 'Release publish',
          risk: 'write',
          can: 'Publish approved release notes.',
          cannot: 'Read unrelated accounts.',
          requiredEnvVars: [],
          commandTemplates: ['python3 ${skillRoot}/publish.py'],
        },
      ],
    });
    const staleSelectedSkill = skill({
      id: 'skill:stale',
      name: 'stale-skill',
      status: 'disabled',
      description: 'Disabled skill must remain selected metadata only.',
    });
    const activeMcpServer = mcpServer({
      id: 'mcp:linear',
      name: 'linear',
      displayName: 'Linear',
      description: 'Search issue inventory.',
      status: 'active',
    });
    const inactiveSameAppMcpServer = mcpServer({
      id: 'mcp:inactive',
      name: 'inactive',
      displayName: 'Inactive MCP',
      description: 'Existing inactive source.',
      status: 'disabled',
    });
    const toolRepository = toolRepositoryFixture({
      selectedTool: tool({
        id: 'tool:crm',
        name: 'capability:crm.records.read',
        displayName: 'CRM records',
        inputSchema: semanticCapabilityInputSchema(readyAction),
      }),
      broadTools: [
        tool({
          id: 'tool:analytics',
          name: 'capability:analytics.query',
          displayName: 'Analytics query',
          inputSchema: semanticCapabilityInputSchema(broadInventoryAction),
        }),
      ],
    });
    const skillRepository = skillRepositoryFixture({
      skills: [selectedSkill, staleSelectedSkill],
    });
    const mcpRepository = mcpRepositoryFixture({
      servers: [activeMcpServer, inactiveSameAppMcpServer],
    });
    const deps = {
      getToolRepository: vi.fn(() => toolRepository as never),
      getSkillRepository: vi.fn(() => skillRepository as never),
      getMcpServerRepository: vi.fn(() => mcpRepository as never),
      getAgentLockStatus: vi.fn(() => 'locked'),
    } as Partial<GroupProcessingDeps> as GroupProcessingDeps;

    const context = await resolveGroupAgentAccessContext({
      deps,
      turnContext: { appId: APP_ID, agentId: AGENT_ID },
      catalogScope: { appId: APP_ID, agentId: AGENT_ID },
      agentFolder: '/tmp/lat-2-agent',
    });

    expect(context.configuredToolPolicy.toolPolicyRules).toEqual([
      'capability:crm.records.read',
    ]);
    expect(context.configuredToolPolicy.runtimeAccess).toEqual([
      expect.objectContaining({
        sourceType: 'configured_adapter',
        selectedCapabilityId: 'crm.records.read',
      }),
    ]);
    expect(context.selectedSkillContext.ids).toEqual([
      'skill:release-writer',
      'skill:stale',
    ]);
    expect(context.selectedSkillContext.displays).toEqual([
      'release-writer (skill:release-writer)',
      'stale-skill (skill:stale)',
    ]);
    expect(context.attachedMcpSourceIds).toEqual([
      'mcp:linear',
      'mcp:inactive',
    ]);
    expect(
      context.semanticCapabilities.map((capability) => capability.capabilityId),
    ).toEqual(['analytics.query', 'crm.records.read', 'skill.release.publish']);
    expect(context.capabilityCatalog.readyActions).toEqual([
      expect.objectContaining({
        kind: 'reviewed_capability',
        stableRef: 'crm.records.read',
      }),
    ]);
    expect(context.capabilityCatalog.installedSkills).toEqual([
      expect.objectContaining({
        kind: 'skill',
        stableRef: 'skill:release-writer',
      }),
    ]);
    expect(context.capabilityCatalog.connectedMcpSources).toEqual([
      expect.objectContaining({
        kind: 'mcp_source',
        stableRef: 'mcp:linear',
      }),
    ]);
    expect(context.currentAccessFingerprint).toMatch(
      /^provider-session-access:v2:[0-9a-f]{64}$/,
    );
    expect(context.currentAccessFingerprint).not.toBe(
      buildProviderSessionAccessFingerprint({
        accessPreset: 'full',
        toolPolicyRules: context.configuredToolPolicy.toolPolicyRules,
        runtimeAccess: context.configuredToolPolicy.runtimeAccess,
        attachedSkillSourceIds: context.selectedSkillContext.ids,
        attachedMcpSourceIds: context.attachedMcpSourceIds,
        semanticCapabilities: context.semanticCapabilities,
        capabilityCatalogDigest: context.capabilityCatalog.digest,
      }),
    );
    expect(Object.isFrozen(context.accessSnapshot?.skills)).toBe(true);
    expect(
      Object.isFrozen(
        context.accessSnapshot?.skills.enabledDefinitions[0]?.promptRefs,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        context.accessSnapshot?.mcp.materializedServers[0]?.definition.config,
      ),
    ).toBe(true);
    expect(() => {
      (
        context.accessSnapshot!.skills.enabledDefinitions[0]!
          .promptRefs as string[]
      ).push('MUTATED.md');
    }).toThrow();

    expect({
      listAgentToolAccessSnapshot:
        toolRepository.listAgentToolAccessSnapshot.mock.calls.length,
      listAgentSkillAccessSnapshot:
        skillRepository.listAgentSkillAccessSnapshot.mock.calls.length,
      listAgentMcpAccessSnapshot:
        mcpRepository.listAgentMcpAccessSnapshot.mock.calls.length,
      listAgentToolBindings:
        toolRepository.listAgentToolBindings.mock.calls.length,
      getTool: toolRepository.getTool.mock.calls.length,
      listTools: toolRepository.listTools.mock.calls.length,
      listAgentSkillBindings:
        skillRepository.listAgentSkillBindings.mock.calls.length,
      listEnabledSkillsForAgent:
        skillRepository.listEnabledSkillsForAgent.mock.calls.length,
      getSkill: skillRepository.getSkill.mock.calls.length,
      listAgentBindings: mcpRepository.listAgentBindings.mock.calls.length,
      getServer: mcpRepository.getServer.mock.calls.length,
    }).toEqual({
      listAgentToolAccessSnapshot: 1,
      listAgentSkillAccessSnapshot: 1,
      listAgentMcpAccessSnapshot: 1,
      listAgentToolBindings: 0,
      getTool: 0,
      listTools: 0,
      listAgentSkillBindings: 0,
      listEnabledSkillsForAgent: 0,
      getSkill: 0,
      listAgentBindings: 0,
      getServer: 0,
    });
  });

  it('loads catalog inventory without granting executable access when turn context is unavailable', async () => {
    const catalogSkill = skill({
      id: 'skill:catalog-only',
      name: 'catalog-only',
      description: 'Visible in the prompt catalog only.',
    });
    const catalogMcpServer = mcpServer({
      id: 'mcp:catalog-only',
      name: 'catalog-only',
      displayName: 'Catalog-only MCP',
      description: 'Visible in the prompt catalog only.',
      status: 'active',
    });
    const toolRepository = toolRepositoryFixture({
      selectedTool: tool({
        id: 'tool:catalog-only',
        name: 'capability:catalog.only',
        displayName: 'Catalog-only tool',
        inputSchema: {},
      }),
      broadTools: [],
    });
    const skillRepository = skillRepositoryFixture({
      skills: [catalogSkill],
    });
    const mcpRepository = mcpRepositoryFixture({
      servers: [catalogMcpServer],
    });
    const deps = {
      getToolRepository: vi.fn(() => toolRepository as never),
      getSkillRepository: vi.fn(() => skillRepository as never),
      getMcpServerRepository: vi.fn(() => mcpRepository as never),
      getAgentLockStatus: vi.fn(() => 'locked'),
    } as Partial<GroupProcessingDeps> as GroupProcessingDeps;

    const context = await resolveGroupAgentAccessContext({
      deps,
      turnContext: undefined,
      catalogScope: { appId: APP_ID, agentId: AGENT_ID },
      agentFolder: '/tmp/lat-2-catalog-only-agent',
    });

    expect(context.accessSnapshot).toBeUndefined();
    expect(context.configuredToolPolicy).toEqual({
      toolPolicyRules: undefined,
      runtimeAccess: [],
      semanticCapabilities: [],
    });
    expect(context.selectedSkillContext).toEqual({});
    expect(context.semanticCapabilities).toEqual([]);
    expect(context.attachedMcpSourceIds).toBeUndefined();
    expect(context.approvedSkillContextBlock).toBe('');
    expect(context.capabilityCatalog.readyActions).toEqual([]);
    expect(context.capabilityCatalog.installedSkills).toEqual([
      expect.objectContaining({
        kind: 'skill',
        stableRef: 'skill:catalog-only',
      }),
    ]);
    expect(context.capabilityCatalog.connectedMcpSources).toEqual([
      expect.objectContaining({
        kind: 'mcp_source',
        stableRef: 'mcp:catalog-only',
      }),
    ]);
    expect(context.capabilityCatalog.digest).not.toBe(
      resolveAgentPromptCapabilityCatalog({
        appId: APP_ID,
        agentId: AGENT_ID,
      }).digest,
    );

    expect({
      listAgentToolAccessSnapshot:
        toolRepository.listAgentToolAccessSnapshot.mock.calls.length,
      listAgentSkillAccessSnapshot:
        skillRepository.listAgentSkillAccessSnapshot.mock.calls.length,
      listAgentMcpAccessSnapshot:
        mcpRepository.listAgentMcpAccessSnapshot.mock.calls.length,
      listAgentToolBindings:
        toolRepository.listAgentToolBindings.mock.calls.length,
      getTool: toolRepository.getTool.mock.calls.length,
      listTools: toolRepository.listTools.mock.calls.length,
      listAgentSkillBindings:
        skillRepository.listAgentSkillBindings.mock.calls.length,
      listEnabledSkillsForAgent:
        skillRepository.listEnabledSkillsForAgent.mock.calls.length,
      getSkill: skillRepository.getSkill.mock.calls.length,
      listAgentBindings: mcpRepository.listAgentBindings.mock.calls.length,
      getServer: mcpRepository.getServer.mock.calls.length,
    }).toEqual({
      listAgentToolAccessSnapshot: 1,
      listAgentSkillAccessSnapshot: 1,
      listAgentMcpAccessSnapshot: 1,
      listAgentToolBindings: 0,
      getTool: 0,
      listTools: 0,
      listAgentSkillBindings: 0,
      listEnabledSkillsForAgent: 0,
      getSkill: 0,
      listAgentBindings: 0,
      getServer: 0,
    });
  });
});

function semanticCapability(input: {
  capabilityId: string;
  displayName: string;
  can: string;
  category: string;
}): SemanticCapabilityDefinition {
  return {
    capabilityId: input.capabilityId,
    version: 'v1',
    displayName: input.displayName,
    category: input.category,
    risk: 'read',
    can: input.can,
    cannot: 'Grant additional authority.',
    credentialSource: 'none',
    implementationBindings: [{ kind: 'adapter', adapterRef: 'test' }],
  };
}

function tool(input: {
  id: string;
  name: string;
  displayName: string;
  inputSchema: unknown;
}) {
  return {
    id: input.id,
    appId: APP_ID,
    name: input.name,
    kind: 'host',
    provider: 'test',
    displayName: input.displayName,
    description: input.displayName,
    category: 'productivity',
    inputSchema: input.inputSchema,
    risk: 'low',
    selectable: true,
    status: 'active',
    adapterRef: 'test',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function skill(input: {
  id: string;
  name: string;
  description: string;
  status?: 'installed' | 'disabled';
  actionPermissions?: Array<{
    id: string;
    capabilityId: string;
    displayName: string;
    risk: 'read' | 'write' | 'admin';
    can: string;
    cannot: string;
    requiredEnvVars: string[];
    commandTemplates: string[];
  }>;
}) {
  return {
    id: input.id,
    appId: APP_ID,
    agentId: AGENT_ID,
    name: input.name,
    description: input.description,
    source: 'admin_uploaded',
    status: input.status ?? 'installed',
    promptRefs: ['SKILL.md'],
    toolIds: [],
    workflowRefs: [],
    actionPermissions: input.actionPermissions ?? [],
    storage: {
      storageType: 'local-filesystem',
      storageRef: `skills/${input.name}`,
      contentHash: `sha256:${input.id}`,
      sizeBytes: 100,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function mcpServer(input: {
  id: string;
  name: string;
  displayName: string;
  description: string;
  status: 'active' | 'disabled';
}) {
  return {
    id: input.id,
    appId: APP_ID,
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    status: input.status,
    createdSource: 'admin',
    riskClass: 'medium',
    transport: 'http',
    config: {
      transport: 'http',
      url: `https://${input.name}.example.test/mcp`,
    },
    allowedToolPatterns: ['*'],
    autoApproveToolPatterns: [],
    credentialRefs: [],
    networkHosts: [`${input.name}.example.test:443`],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function toolRepositoryFixture(input: {
  selectedTool: ReturnType<typeof tool>;
  broadTools: Array<ReturnType<typeof tool>>;
}): ToolCatalogRepository {
  return {
    listAgentToolAccessSnapshot: vi.fn(async () => ({
      activeBindings: [
        {
          binding: {
            id: 'agent-tool-binding:crm',
            appId: APP_ID,
            agentId: AGENT_ID,
            toolId: input.selectedTool.id,
            status: 'active',
            createdAt: NOW,
            updatedAt: NOW,
          },
          definition: input.selectedTool,
        },
      ],
      appActiveDefinitions: [input.selectedTool, ...input.broadTools],
    })),
    listAgentToolBindings: vi.fn(async () => [
      {
        id: 'agent-tool-binding:crm',
        appId: APP_ID,
        agentId: AGENT_ID,
        toolId: input.selectedTool.id,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]),
    getTool: vi.fn(async (id: string) =>
      id === input.selectedTool.id ? input.selectedTool : null,
    ),
    listTools: vi.fn(async () => [input.selectedTool, ...input.broadTools]),
  } as unknown as ToolCatalogRepository;
}

function skillRepositoryFixture(input: {
  skills: Array<ReturnType<typeof skill>>;
}): SkillCatalogRepository {
  const skills = new Map(input.skills.map((item) => [item.id, item]));
  return {
    listAgentSkillAccessSnapshot: vi.fn(async () => ({
      activeBindings: input.skills.map((item) => ({
        binding: {
          id: `agent-skill-binding:${item.id}`,
          appId: APP_ID,
          agentId: AGENT_ID,
          skillId: item.id,
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
        },
        definition: item,
      })),
      enabledDefinitions: input.skills.filter(
        (item) => item.status === 'installed',
      ),
    })),
    listAgentSkillBindings: vi.fn(async () =>
      input.skills.map((item) => ({
        id: `agent-skill-binding:${item.id}`,
        appId: APP_ID,
        agentId: AGENT_ID,
        skillId: item.id,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      })),
    ),
    getSkill: vi.fn(async (id: string) => skills.get(id) ?? null),
    listEnabledSkillsForAgent: vi.fn(async () =>
      input.skills.filter((item) => item.status === 'installed'),
    ),
  } as unknown as SkillCatalogRepository;
}

function mcpRepositoryFixture(input: {
  servers: Array<ReturnType<typeof mcpServer>>;
}): McpServerRepository {
  const servers = new Map(input.servers.map((server) => [server.id, server]));
  return {
    listAgentMcpAccessSnapshot: vi.fn(async () => ({
      activeBindings: input.servers.map((server) => ({
        binding: {
          id: `agent-mcp-binding:${server.id}`,
          appId: APP_ID,
          agentId: AGENT_ID,
          serverId: server.id,
          status: 'active',
          required: false,
          permissionPolicyIds: [],
          allowedToolPatterns: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
        definition: server,
      })),
      materializedServers: input.servers
        .filter((server) => server.status === 'active')
        .map((server) => ({
          binding: {
            id: `agent-mcp-binding:${server.id}`,
            appId: APP_ID,
            agentId: AGENT_ID,
            serverId: server.id,
            status: 'active',
            required: false,
            permissionPolicyIds: [],
            allowedToolPatterns: [],
            createdAt: NOW,
            updatedAt: NOW,
          },
          definition: server,
        })),
    })),
    listAgentBindings: vi.fn(async () =>
      input.servers.map((server) => ({
        id: `agent-mcp-binding:${server.id}`,
        appId: APP_ID,
        agentId: AGENT_ID,
        serverId: server.id,
        status: 'active',
        required: false,
        permissionPolicyIds: [],
        allowedToolPatterns: [],
        createdAt: NOW,
        updatedAt: NOW,
      })),
    ),
    getServer: vi.fn(async (id: string) => servers.get(id) ?? null),
  } as unknown as McpServerRepository;
}
