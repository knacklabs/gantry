import { describe, expect, it } from 'vitest';

import { AgentCapabilityAdministrationService } from '@core/application/agents/agent-capability-administration-service.js';

describe('AgentCapabilityAdministrationService', () => {
  it('replaces tool, skill, and MCP selections as agent-owned capabilities', async () => {
    const state = createState();
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    const result = await service.replaceCapabilities({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      selectedToolIds: ['tool:Browser' as never],
      selectedSkillIds: ['skill:one' as never],
      selectedMcpServerIds: ['mcp:one' as never],
    });

    expect(result).toMatchObject({
      selectedToolIds: ['tool:Browser'],
      selectedSkillIds: ['skill:one'],
      selectedMcpServerIds: ['mcp:one'],
    });
    expect(state.toolBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolId: 'tool:old', status: 'disabled' }),
        expect.objectContaining({ toolId: 'tool:Browser', status: 'active' }),
      ]),
    );
    expect(state.skillBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skillId: 'skill:old', status: 'disabled' }),
        expect.objectContaining({ skillId: 'skill:one', status: 'active' }),
      ]),
    );
    expect(state.mcpBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: 'mcp:old', status: 'disabled' }),
        expect.objectContaining({
          serverId: 'mcp:one',
          versionId: 'mcp-version:one',
          status: 'active',
        }),
      ]),
    );
  });

  it('rejects disabled or non-selectable catalog tools', async () => {
    const state = createState();
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    await expect(
      service.replaceCapabilities({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        selectedToolIds: ['tool:internal' as never],
        selectedSkillIds: [],
        selectedMcpServerIds: [],
      }),
    ).rejects.toThrow('Tool is not selectable');
  });

  it('rejects selectable catalog rows whose names are invalid durable tool rules', async () => {
    const state = createState();
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    await expect(
      service.replaceCapabilities({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        selectedToolIds: ['tool:BashWildcard' as never],
        selectedSkillIds: [],
        selectedMcpServerIds: [],
      }),
    ).rejects.toThrow('Persistent Bash scope is too broad');

    expect(state.toolBindings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolId: 'tool:BashWildcard',
          status: 'active',
        }),
      ]),
    );
  });
});

function createState() {
  const now = '2026-04-30T00:00:00.000Z';
  const tools = new Map<string, any>([
    [
      'tool:Browser',
      {
        id: 'tool:Browser',
        appId: 'app:one',
        name: 'Browser',
        kind: 'browser',
        provider: 'myclaw',
        displayName: 'Browser',
        category: 'web',
        risk: 'medium',
        selectable: true,
        status: 'active',
        adapterRef: 'builtin:Browser',
        createdAt: now,
        updatedAt: now,
      },
    ],
    [
      'tool:internal',
      {
        id: 'tool:internal',
        appId: 'app:one',
        name: 'Internal',
        kind: 'host',
        provider: 'myclaw',
        displayName: 'Internal',
        category: 'admin',
        risk: 'high',
        selectable: false,
        status: 'active',
        adapterRef: 'builtin:internal',
        createdAt: now,
        updatedAt: now,
      },
    ],
    [
      'tool:BashWildcard',
      {
        id: 'tool:BashWildcard',
        appId: 'app:one',
        name: 'Bash(*)',
        kind: 'sdk',
        provider: 'claude',
        displayName: 'Bash wildcard',
        category: 'execution',
        risk: 'high',
        selectable: true,
        status: 'active',
        adapterRef: 'builtin:Bash',
        createdAt: now,
        updatedAt: now,
      },
    ],
  ]);
  const skills = new Map<string, any>([
    [
      'skill:one',
      {
        id: 'skill:one',
        appId: 'app:one',
        name: 'One',
        version: 'builtin',
        source: 'bundled',
        status: 'approved',
        promptRefs: [],
        toolIds: [],
        workflowRefs: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  ]);
  const mcpServers = new Map<string, any>([
    [
      'mcp:one',
      {
        id: 'mcp:one',
        appId: 'app:one',
        name: 'one',
        status: 'approved',
        createdSource: 'admin',
        riskClass: 'medium',
        latestApprovedVersionId: 'mcp-version:one',
        createdAt: now,
        updatedAt: now,
      },
    ],
  ]);
  const toolBindings: any[] = [
    {
      id: 'agent-tool-binding:agent:one:tool:old',
      appId: 'app:one',
      agentId: 'agent:one',
      toolId: 'tool:old',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  ];
  const skillBindings: any[] = [
    {
      id: 'agent-skill-binding:agent:one:skill:old',
      appId: 'app:one',
      agentId: 'agent:one',
      skillId: 'skill:old',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  ];
  const mcpBindings: any[] = [
    {
      id: 'agent-mcp-binding:agent:one:mcp:old',
      appId: 'app:one',
      agentId: 'agent:one',
      serverId: 'mcp:old',
      versionId: 'mcp-version:old',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
  return {
    toolBindings,
    skillBindings,
    mcpBindings,
    repositories: {
      agents: {
        getAgent: async () => ({
          id: 'agent:one',
          appId: 'app:one',
          name: 'Agent One',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        }),
        replaceAgentCapabilityBindings: async (input: any) => {
          for (const binding of input.toolBindings) {
            const index = toolBindings.findIndex(
              (item) => item.id === binding.id,
            );
            if (index >= 0) toolBindings[index] = binding;
            else toolBindings.push(binding);
          }
          for (const binding of input.skillBindings) {
            const index = skillBindings.findIndex(
              (item) => item.id === binding.id,
            );
            if (index >= 0) skillBindings[index] = binding;
            else skillBindings.push(binding);
          }
          for (const binding of input.mcpBindings) {
            const index = mcpBindings.findIndex(
              (item) => item.id === binding.id,
            );
            if (index >= 0) mcpBindings[index] = binding;
            else mcpBindings.push(binding);
          }
        },
      },
      tools: {
        getTool: async (id: string) => tools.get(id) ?? null,
        listTools: async () => Array.from(tools.values()),
        listAgentToolBindings: async () => toolBindings,
        saveAgentToolBinding: async (binding: any) => {
          const index = toolBindings.findIndex(
            (item) => item.id === binding.id,
          );
          if (index >= 0) toolBindings[index] = binding;
          else toolBindings.push(binding);
        },
        disableAgentToolBinding: async ({ toolId, updatedAt }: any) => {
          const binding = toolBindings.find((item) => item.toolId === toolId);
          if (!binding) return null;
          binding.status = 'disabled';
          binding.updatedAt = updatedAt;
          return binding;
        },
      },
      skills: {
        getSkill: async (id: string) => skills.get(id) ?? null,
        listSkills: async () => Array.from(skills.values()),
        listAgentSkillBindings: async () => skillBindings,
        saveAgentSkillBinding: async (binding: any) => {
          const index = skillBindings.findIndex(
            (item) => item.id === binding.id,
          );
          if (index >= 0) skillBindings[index] = binding;
          else skillBindings.push(binding);
        },
        disableAgentSkillBinding: async ({ skillId, updatedAt }: any) => {
          const binding = skillBindings.find(
            (item) => item.skillId === skillId,
          );
          if (!binding) return null;
          binding.status = 'disabled';
          binding.updatedAt = updatedAt;
          return binding;
        },
      },
      mcpServers: {
        getServer: async (id: string) => mcpServers.get(id) ?? null,
        listServers: async () => Array.from(mcpServers.values()),
        listAgentBindings: async () => mcpBindings,
        saveAgentBinding: async (binding: any) => {
          const index = mcpBindings.findIndex((item) => item.id === binding.id);
          if (index >= 0) mcpBindings[index] = binding;
          else mcpBindings.push(binding);
        },
        disableAgentBinding: async ({ serverId, updatedAt }: any) => {
          const binding = mcpBindings.find(
            (item) => item.serverId === serverId,
          );
          if (!binding) return null;
          binding.status = 'disabled';
          binding.updatedAt = updatedAt;
          return binding;
        },
      },
    } as never,
  };
}
