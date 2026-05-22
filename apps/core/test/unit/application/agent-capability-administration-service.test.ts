import { describe, expect, it } from 'vitest';

import { AgentCapabilityAdministrationService } from '@core/application/agents/agent-capability-administration-service.js';

describe('AgentCapabilityAdministrationService', () => {
  it('replaces capabilities and sources through separate agent-owned views', async () => {
    const state = createState();
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    const capabilities = await service.replaceCapabilities({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      capabilities: [{ id: 'browser.use', version: 'builtin' }],
    });
    const sources = await service.replaceSources({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      sources: {
        skills: [{ id: 'skill:one', version: 'approved' }],
        mcpServers: [{ id: 'mcp:one', version: 'mcp-version:one' }],
        tools: [{ id: 'browser', kind: 'builtin' }],
      },
    });

    expect(capabilities).toMatchObject({
      capabilities: [{ id: 'browser.use', version: 'builtin' }],
    });
    expect(sources).toMatchObject({
      sources: {
        skills: [{ id: 'skill:one', version: 'approved' }],
        mcpServers: [{ id: 'mcp:one', version: 'mcp-version:one' }],
        tools: [{ id: 'browser', kind: 'builtin' }],
      },
    });
    expect(state.toolSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'browser',
          kind: 'builtin',
          status: 'active',
        }),
      ]),
    );
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

  it('rejects unknown semantic capabilities', async () => {
    const state = createState();
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    await expect(
      service.replaceCapabilities({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        capabilities: [{ id: 'internal.tool', version: 'builtin' }],
      }),
    ).rejects.toThrow('Unknown semantic capability internal.tool');
  });

  it('stores tool sources without granting tool authority', async () => {
    const state = createState();
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    const response = await service.replaceSources({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      sources: {
        skills: [],
        mcpServers: [],
        tools: [
          { id: 'browser', kind: 'builtin' },
          { id: 'gog', kind: 'local_cli', version: 'v0.9.0' },
        ],
      },
    });

    expect(response.sources.tools).toEqual([
      { id: 'browser', kind: 'builtin' },
      { id: 'gog', kind: 'local_cli', version: 'v0.9.0' },
    ]);

    expect(state.toolBindings).toEqual([
      expect.objectContaining({ toolId: 'tool:old', status: 'active' }),
    ]);
    expect(state.toolSources).toEqual([
      expect.objectContaining({
        sourceId: 'browser',
        kind: 'builtin',
        status: 'active',
      }),
      expect.objectContaining({
        sourceId: 'gog',
        kind: 'local_cli',
        version: 'v0.9.0',
        status: 'active',
      }),
    ]);
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
        capabilities: [{ id: 'RunCommand(*)', version: 'builtin' }],
      }),
    ).rejects.toThrow('Persistent RunCommand scope is too broad');

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
        provider: 'gantry',
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
        provider: 'gantry',
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
        name: 'RunCommand(*)',
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
        latestApprovedVersionId: 'mcp-version:two',
        createdAt: now,
        updatedAt: now,
      },
    ],
  ]);
  const mcpVersions = new Map<string, any>([
    [
      'mcp-version:one',
      {
        id: 'mcp-version:one',
        appId: 'app:one',
        serverId: 'mcp:one',
        version: 1,
      },
    ],
    [
      'mcp-version:two',
      {
        id: 'mcp-version:two',
        appId: 'app:one',
        serverId: 'mcp:one',
        version: 2,
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
  const toolSources: any[] = [];
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
    toolSources,
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
          for (const binding of toolBindings) {
            if (
              !input.toolBindings.some(
                (next: any) => next.toolId === binding.toolId,
              )
            ) {
              binding.status = 'disabled';
              binding.updatedAt = input.updatedAt;
            }
          }
          for (const binding of input.toolBindings) {
            const index = toolBindings.findIndex(
              (item) => item.id === binding.id,
            );
            if (index >= 0) toolBindings[index] = binding;
            else toolBindings.push(binding);
          }
          for (const binding of skillBindings) {
            if (
              !input.skillBindings.some(
                (next: any) => next.skillId === binding.skillId,
              )
            ) {
              binding.status = 'disabled';
              binding.updatedAt = input.updatedAt;
            }
          }
          for (const binding of input.skillBindings) {
            const index = skillBindings.findIndex(
              (item) => item.id === binding.id,
            );
            if (index >= 0) skillBindings[index] = binding;
            else skillBindings.push(binding);
          }
          for (const binding of mcpBindings) {
            if (
              !input.mcpBindings.some(
                (next: any) => next.serverId === binding.serverId,
              )
            ) {
              binding.status = 'disabled';
              binding.updatedAt = input.updatedAt;
            }
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
        listAgentToolSources: async () => toolSources,
        replaceAgentToolSources: async (input: any) => {
          for (const source of toolSources) {
            if (
              !input.sources.some(
                (next: any) =>
                  next.sourceId === source.sourceId &&
                  next.kind === source.kind &&
                  next.version === source.version,
              )
            ) {
              source.status = 'disabled';
              source.updatedAt = input.updatedAt;
            }
          }
          for (const source of input.sources) {
            const index = toolSources.findIndex(
              (item) => item.id === source.id,
            );
            if (index >= 0) toolSources[index] = source;
            else toolSources.push(source);
          }
        },
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
        getVersion: async (id: string) => mcpVersions.get(id) ?? null,
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
