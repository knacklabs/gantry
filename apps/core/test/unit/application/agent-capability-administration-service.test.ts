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
        skills: [
          {
            name: 'stale-display-name',
            id: 'skill:one',
          },
        ],
        mcpServers: [{ id: 'mcp:one' }],
        tools: [{ id: 'browser', kind: 'builtin' }],
      },
    });

    expect(capabilities).toMatchObject({
      capabilities: [{ id: 'browser.use', version: 'builtin' }],
    });
    expect(sources).toMatchObject({
      sources: {
        skills: [{ name: 'One', id: 'skill:one' }],
        mcpServers: [{ id: 'mcp:one' }],
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
          status: 'active',
        }),
      ]),
    );
  });

  it('replaces a full access document and validates selections against requested sources', async () => {
    const state = createState();
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    const response = await service.replaceAccessDocument({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      sources: {
        skills: [{ id: 'skill:one' }],
        mcpServers: [{ id: 'mcp:one' }],
        tools: [{ id: 'browser', kind: 'builtin' }],
      },
      capabilities: [
        { id: 'skill.one.publish', version: 'builtin' },
        { id: 'browser.use', version: 'builtin' },
      ],
    });

    expect(response.sources.skills).toEqual([{ id: 'skill:one', name: 'One' }]);
    expect(response.capabilities).toEqual([
      { id: 'skill.one.publish', version: 'builtin' },
      { id: 'browser.use', version: 'builtin' },
    ]);
    expect(state.skillBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skillId: 'skill:old', status: 'disabled' }),
        expect.objectContaining({ skillId: 'skill:one', status: 'active' }),
      ]),
    );
    expect(state.toolSources).toEqual([
      expect.objectContaining({
        sourceId: 'browser',
        kind: 'builtin',
        status: 'active',
      }),
    ]);
  });

  it('round-trips scoped MCP source tools through the full access document', async () => {
    const state = createState();
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    const response = await service.replaceAccessDocument({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      sources: {
        skills: [],
        mcpServers: [{ id: 'mcp:one', tools: ['read_*'] }],
        tools: [],
      },
      capabilities: [],
    });

    expect(response.sources.mcpServers).toEqual([
      { id: 'mcp:one', tools: ['read_*'] },
    ]);
    expect(state.mcpBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: 'mcp:one',
          status: 'active',
          allowedToolPatterns: ['read_*'],
        }),
      ]),
    );
  });

  it('rejects invalid full access selections before writing requested sources', async () => {
    const state = createState();
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    await expect(
      service.replaceAccessDocument({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        sources: {
          skills: [{ id: 'skill:one' }],
          mcpServers: [],
          tools: [{ id: 'browser', kind: 'builtin' }],
        },
        capabilities: [{ id: 'unknown.capability', version: 'builtin' }],
      }),
    ).rejects.toThrow('Unknown semantic capability unknown.capability');

    expect(state.toolSources).toEqual([]);
    expect(state.skillBindings).toEqual([
      expect.objectContaining({ skillId: 'skill:old', status: 'active' }),
    ]);
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

  it('round-trips exact tools from the capability read response during replacement', async () => {
    const state = createState();
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    const response = await service.replaceCapabilities({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      capabilities: [
        { id: 'mcp__gantry__settings_desired_state', version: 'builtin' },
        { id: 'FileWrite', version: 'builtin' },
        { id: 'browser.use', version: 'builtin' },
      ],
    });

    expect(response.capabilities).toEqual([
      { id: 'mcp__gantry__settings_desired_state', version: 'builtin' },
      { id: 'FileWrite', version: 'builtin' },
      { id: 'browser.use', version: 'builtin' },
    ]);
    expect(response.toolAccess.configuredTools).toEqual([
      'mcp__gantry__settings_desired_state',
      'FileWrite',
      'Browser',
    ]);
  });

  it('rejects selected skills that collide by materialized runtime directory', async () => {
    const state = createState();
    state.skills.set('skill:two', {
      ...state.skills.get('skill:one')!,
      id: 'skill:two',
      name: 'one',
    });
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    await expect(
      service.replaceSources({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        sources: {
          skills: [{ id: 'skill:one' }, { id: 'skill:two' }],
          mcpServers: [],
          tools: [],
        },
      }),
    ).rejects.toThrow(
      'Selected skills that materialize to the same runtime directory "one": skill:one, skill:two. Keep only one exact skill id.',
    );
  });

  it('stores tool sources without creating tool authority', async () => {
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
          { id: 'acme', kind: 'local_cli', version: 'v0.9.0' },
        ],
      },
    });

    expect(response.sources.tools).toEqual([
      { id: 'browser', kind: 'builtin' },
      { id: 'acme', kind: 'local_cli', version: 'v0.9.0' },
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
        sourceId: 'acme',
        kind: 'local_cli',
        version: 'v0.9.0',
        status: 'active',
      }),
    ]);
  });

  it('reports old generated skill command grants as selected skill action capabilities', async () => {
    const state = createState();
    state.tools.set('tool:generated-skill-command', {
      id: 'tool:generated-skill-command',
      appId: 'app:one',
      name: 'RunCommand(/tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
      kind: 'host',
      provider: 'gantry',
      displayName: 'Generated skill command',
      category: 'admin',
      risk: 'high',
      selectable: true,
      status: 'active',
      adapterRef: 'permission/request_permission',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    state.skills.set('skill:linkedin-posting', {
      id: 'skill:linkedin-posting',
      appId: 'app:one',
      name: 'linkedin-posting',
      version: '1',
      source: 'admin_uploaded',
      status: 'installed',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      actionPermissions: [
        {
          id: 'publish',
          capabilityId: 'skill.linkedin-posting.publish',
          displayName: 'LinkedIn posting',
          risk: 'write',
          can: 'Publish a prepared LinkedIn post through the installed script.',
          cannot:
            'Use unrelated skills, credentials, settings, or broader commands.',
          requiredEnvVars: [],
          commandTemplates: ['skills/linkedin-posting/post.py *'],
        },
      ],
      storage: {
        storageType: 'local-filesystem',
        storageRef: 'skills/linkedin-posting',
        contentHash: 'sha256:linkedin',
        sizeBytes: 1,
      },
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    state.toolBindings.push({
      id: 'agent-tool-binding:generated-skill-command',
      appId: 'app:one',
      agentId: 'agent:one',
      toolId: 'tool:generated-skill-command',
      status: 'active',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    state.skillBindings.push({
      id: 'agent-skill-binding:linkedin-posting',
      appId: 'app:one',
      agentId: 'agent:one',
      skillId: 'skill:linkedin-posting',
      status: 'active',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    const service = new AgentCapabilityAdministrationService(
      state.repositories,
      { now: () => '2026-05-01T00:00:00.000Z' },
    );

    const response = await service.getCapabilities({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
    });

    expect(response.capabilities).toContainEqual({
      id: 'skill.linkedin-posting.publish',
      version: 'builtin',
    });
    expect(response.capabilities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining('.llm-runtime'),
        }),
      ]),
    );
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

  it('rejects broad and secret-bearing RunCommand selections', async () => {
    for (const capabilityId of [
      'RunCommand(npm *)',
      'RunCommand(curl *)',
      'RunCommand(git *)',
      'RunCommand(skills/poster/post.py --token sk-abcdefghij0123456789abcd)',
      'RunCommand(/tmp/run/.llm-runtime/claude/skills/poster/post.py *)',
    ]) {
      const state = createState();
      const service = new AgentCapabilityAdministrationService(
        state.repositories,
        { now: () => '2026-05-01T00:00:00.000Z' },
      );
      const initialToolCount = state.tools.size;
      const initialBindingCount = state.toolBindings.length;

      await expect(
        service.replaceCapabilities({
          appId: 'app:one' as never,
          agentId: 'agent:one' as never,
          capabilities: [{ id: capabilityId, version: 'builtin' }],
        }),
      ).rejects.toThrow();

      expect(state.tools.size).toBe(initialToolCount);
      expect(state.toolBindings).toHaveLength(initialBindingCount);
    }
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
      'tool:mcp__gantry__settings_desired_state',
      {
        id: 'tool:mcp__gantry__settings_desired_state',
        appId: 'app:one',
        name: 'mcp__gantry__settings_desired_state',
        kind: 'host',
        provider: 'gantry',
        displayName: 'Settings desired state',
        category: 'admin',
        risk: 'high',
        selectable: true,
        status: 'active',
        adapterRef: 'builtin:mcp__gantry__settings_desired_state',
        createdAt: now,
        updatedAt: now,
      },
    ],
    [
      'tool:FileWrite',
      {
        id: 'tool:FileWrite',
        appId: 'app:one',
        name: 'FileWrite',
        kind: 'host',
        provider: 'gantry',
        displayName: 'File write',
        category: 'filesystem',
        risk: 'high',
        selectable: true,
        status: 'active',
        adapterRef: 'builtin:FileWrite',
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
        status: 'installed',
        promptRefs: [],
        toolIds: [],
        workflowRefs: [],
        actionPermissions: [
          {
            id: 'publish',
            capabilityId: 'skill.one.publish',
            displayName: 'One publish',
            risk: 'write',
            can: 'Publish through the installed One skill.',
            cannot: 'Use unrelated skills, credentials, settings, or commands.',
            requiredEnvVars: [],
            commandTemplates: ['skills/one/publish.py *'],
          },
        ],
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
        status: 'active',
        createdSource: 'admin',
        riskClass: 'medium',
        transport: 'stdio_template',
        config: { transport: 'stdio_template', templateId: 'node-script' },
        allowedToolPatterns: ['read_*', 'write_*'],
        autoApproveToolPatterns: [],
        credentialRefs: [],
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
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
  const replaceCapabilityBindings = async (input: any) => {
    for (const binding of toolBindings) {
      if (
        !input.toolBindings.some((next: any) => next.toolId === binding.toolId)
      ) {
        binding.status = 'disabled';
        binding.updatedAt = input.updatedAt;
      }
    }
    for (const binding of input.toolBindings) {
      const index = toolBindings.findIndex((item) => item.id === binding.id);
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
      const index = skillBindings.findIndex((item) => item.id === binding.id);
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
      const index = mcpBindings.findIndex((item) => item.id === binding.id);
      if (index >= 0) mcpBindings[index] = binding;
      else mcpBindings.push(binding);
    }
  };
  const replaceToolSources = async (input: any) => {
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
      const index = toolSources.findIndex((item) => item.id === source.id);
      if (index >= 0) toolSources[index] = source;
      else toolSources.push(source);
    }
  };
  return {
    tools,
    skills,
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
        replaceAgentCapabilityBindings: replaceCapabilityBindings,
        replaceAgentAccess: async (input: any) => {
          await replaceCapabilityBindings(input);
          await replaceToolSources({
            appId: input.appId,
            agentId: input.agentId,
            sources: input.toolSources,
            updatedAt: input.updatedAt,
          });
        },
      },
      tools: {
        getTool: async (id: string) => tools.get(id) ?? null,
        listTools: async () => Array.from(tools.values()),
        saveTool: async (tool: any) => {
          tools.set(tool.id, tool);
        },
        listAgentToolBindings: async () => toolBindings,
        listAgentToolSources: async () => toolSources,
        replaceAgentToolSources: replaceToolSources,
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
