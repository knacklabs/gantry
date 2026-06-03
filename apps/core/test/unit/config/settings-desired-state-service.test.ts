import { describe, expect, it, vi } from 'vitest';

import {
  classifySettingsChanges,
  SettingsDesiredStateService,
} from '@core/config/settings/desired-state-service.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { ConversationAdministrationService } from '@core/application/provider-conversations/conversation-administration-service.js';
import {
  semanticCapabilityInputSchema,
  type SemanticCapabilityDefinition,
} from '@core/shared/semantic-capabilities.js';

function emptySources() {
  return { skills: [], mcpServers: [], tools: [] };
}

function linkedinPostingSkill() {
  return {
    id: 'skill:linkedin-posting',
    appId: 'default',
    name: 'linkedin-posting',
    description: 'LinkedIn posting',
    source: 'admin_uploaded',
    status: 'installed',
    promptRefs: [],
    toolIds: [],
    workflowRefs: [],
    requiredEnvVars: ['LINKEDIN_ACCESS_TOKEN'],
    actionPermissions: [
      {
        id: 'publish',
        capabilityId: 'skill.linkedin-posting.publish',
        displayName: 'LinkedIn posting',
        risk: 'write',
        can: 'Publish a prepared LinkedIn post through the approved script.',
        cannot: 'Read unrelated accounts or receive raw credentials.',
        requiredEnvVars: ['LINKEDIN_ACCESS_TOKEN'],
        commandTemplates: ['skills/linkedin-posting/post.py *'],
      },
    ],
    storage: {
      storageType: 'local-filesystem',
      storageRef: 'skills/linkedin-posting',
      contentHash: 'sha256:linkedin-v1',
      sizeBytes: 128,
    },
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  };
}

function acmeRecordsAppendCapability(): SemanticCapabilityDefinition {
  return {
    capabilityId: 'acme.records.append',
    displayName: 'Acme records append',
    category: 'Acme',
    risk: 'write',
    can: 'Append reviewed records through configured access.',
    cannot: 'Read unrelated accounts or receive raw credentials.',
    credentialSource: 'configured_access',
    implementationBindings: [
      {
        kind: 'tool_rule',
        rule: 'RunCommand(/usr/local/bin/acme records append *)',
      },
    ],
    preflight: { kind: 'none' },
  };
}

function semanticCapabilityTool(capability: SemanticCapabilityDefinition) {
  return {
    id: `tool:capability:${capability.capabilityId}`,
    appId: 'default',
    name: `capability:${capability.capabilityId}`,
    kind: 'host',
    provider: 'gantry',
    displayName: capability.displayName,
    category: 'productivity',
    risk: 'high',
    selectable: true,
    status: 'active',
    adapterRef: `capability/${capability.capabilityId}`,
    inputSchema: semanticCapabilityInputSchema(capability),
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  };
}

function makeRepositories(overrides: Record<string, unknown> = {}) {
  return {
    agents: {
      saveAgent: vi.fn(async () => undefined),
      replaceAgentCapabilityBindings: vi.fn(async () => undefined),
      disableAgent: vi.fn(async () => undefined),
      listAgents: vi.fn(async () => []),
    },
    tools: {
      getTool: vi.fn(async (id: string) =>
        id === 'tool:read'
          ? {
              id,
              appId: 'default',
              name: 'Read',
              status: 'active',
              selectable: true,
            }
          : null,
      ),
      saveTool: vi.fn(async () => undefined),
      listTools: vi.fn(async () => [
        {
          id: 'tool:read',
          appId: 'default',
          name: 'Read',
          status: 'active',
          selectable: true,
        },
      ]),
      listAgentToolBindings: vi.fn(async () => []),
      listAgentToolBindingsForAgents: vi.fn(async () => []),
      listAgentToolSources: vi.fn(async () => []),
      listAgentToolSourcesForAgents: vi.fn(async () => []),
      replaceAgentToolSources: vi.fn(async () => undefined),
    },
    skills: {
      getSkill: vi.fn(async (id: string) =>
        id === 'skill:admin'
          ? {
              id,
              appId: 'default',
              name: 'admin',
              status: 'installed',
              storage: { type: 'local' },
            }
          : null,
      ),
      listSkills: vi.fn(async () => [
        {
          id: 'skill:admin',
          appId: 'default',
          name: 'admin',
          status: 'installed',
          storage: { type: 'local' },
        },
      ]),
      listAgentSkillBindings: vi.fn(async () => []),
      listAgentSkillBindingsForAgents: vi.fn(async () => []),
    },
    mcpServers: {
      getServer: vi.fn(async (id: string) =>
        id === 'mcp:github'
          ? {
              id,
              appId: 'default',
              status: 'active',
              name: 'github',
              createdSource: 'admin',
              riskClass: 'medium',
              transport: 'stdio_template',
              config: { transport: 'stdio_template', templateId: 'github' },
              allowedToolPatterns: [],
              autoApproveToolPatterns: [],
              credentialRefs: [],
            }
          : null,
      ),
      listAgentBindings: vi.fn(async () => []),
      listAgentBindingsForAgents: vi.fn(async () => []),
    },
    providerConnections: {
      getProviderConnection: vi.fn(async (id: string) => ({
        id,
        appId: 'default',
        providerId: id.replace(/_default$/, ''),
        label: id,
        status: 'active',
        config: {},
        runtimeSecretRefs: [],
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z',
      })),
      saveProviderConnection: vi.fn(async () => undefined),
      saveAgentConversationBinding: vi.fn(async () => undefined),
    },
    ...overrides,
  } as any;
}

function makeOps(groups: Record<string, any> = {}) {
  return {
    getAllConversationRoutes: vi.fn(async () => groups),
    setConversationRoute: vi.fn(async () => undefined),
    deleteConversationRoute: vi.fn(async () => undefined),
  };
}

describe('SettingsDesiredStateService', () => {
  it('validates capability references before reconciliation', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [{ id: 'skill:admin' }],
        mcpServers: [{ id: 'mcp:github' }],
        tools: [],
      },
      capabilities: [
        { id: 'acme.records.append', version: 'builtin' },
        { id: 'tool:read', version: 'builtin' },
        { id: '*', version: 'builtin' },
      ],
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories: makeRepositories(),
    });

    const errors = await service.validateCapabilityReferences(settings);

    expect([...errors].sort()).toEqual(
      [
        'agents.main_agent.capabilities contains unavailable capability *: Capability id must use lowercase dot-separated words such as app.resource.action.',
        'agents.main_agent.capabilities contains unavailable capability acme.records.append: Unknown semantic capability acme.records.append. Review and register a user-defined capability before selecting it.',
        'agents.main_agent.capabilities contains unavailable capability tool:read: Capability id must use lowercase dot-separated words such as app.resource.action.',
      ].sort(),
    );
  });

  it('resolves readable skill names from desired-state settings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [{ id: 'admin' }],
        mcpServers: [],
        tools: [],
      },
      capabilities: [],
    };
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        skillBindings: [expect.objectContaining({ skillId: 'skill:admin' })],
      }),
    );
  });

  it('reconciles configured MCP source ids', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [],
        mcpServers: [{ id: 'mcp:github' }],
        tools: [],
      },
      capabilities: [],
    };
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpBindings: [
          expect.objectContaining({
            serverId: 'mcp:github',
          }),
        ],
      }),
    );
  });

  it('reconciles configured MCP source tool scope only within reviewed server tools', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [],
        mcpServers: [{ id: 'mcp:github', tools: ['read_*'] }],
        tools: [],
      },
      capabilities: [],
    };
    const repositories = makeRepositories({
      mcpServers: {
        ...makeRepositories().mcpServers,
        getServer: vi.fn(async (id: string) =>
          id === 'mcp:github'
            ? {
                id,
                appId: 'default',
                status: 'active',
                name: 'github',
                createdSource: 'admin',
                riskClass: 'medium',
                transport: 'stdio_template',
                config: { transport: 'stdio_template', templateId: 'github' },
                allowedToolPatterns: ['read_*', 'write_*'],
                autoApproveToolPatterns: [],
                credentialRefs: [],
              }
            : null,
        ),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpBindings: [
          expect.objectContaining({
            serverId: 'mcp:github',
            allowedToolPatterns: ['read_*'],
          }),
        ],
      }),
    );
  });

  it('reconciles MCP source scopes against auto-approved tools when allowed tools are empty', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [],
        mcpServers: [{ id: 'mcp:github', tools: ['search'] }],
        tools: [],
      },
      capabilities: [],
    };
    const repositories = makeRepositories({
      mcpServers: {
        ...makeRepositories().mcpServers,
        getServer: vi.fn(async (id: string) =>
          id === 'mcp:github'
            ? {
                id,
                appId: 'default',
                status: 'active',
                name: 'github',
                createdSource: 'admin',
                riskClass: 'medium',
                transport: 'stdio_template',
                config: { transport: 'stdio_template', templateId: 'github' },
                allowedToolPatterns: [],
                autoApproveToolPatterns: ['search'],
                credentialRefs: [],
              }
            : null,
        ),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpBindings: [
          expect.objectContaining({
            serverId: 'mcp:github',
            allowedToolPatterns: ['search'],
          }),
        ],
      }),
    );
  });

  it('rejects configured MCP source tool scope wider than reviewed server tools', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [],
        mcpServers: [{ id: 'mcp:github', tools: ['delete_*'] }],
        tools: [],
      },
      capabilities: [],
    };
    const repositories = makeRepositories({
      mcpServers: {
        ...makeRepositories().mcpServers,
        getServer: vi.fn(async (id: string) =>
          id === 'mcp:github'
            ? {
                id,
                appId: 'default',
                status: 'active',
                name: 'github',
                createdSource: 'admin',
                riskClass: 'medium',
                transport: 'stdio_template',
                config: { transport: 'stdio_template', templateId: 'github' },
                allowedToolPatterns: ['read_*'],
                autoApproveToolPatterns: [],
                credentialRefs: [],
              }
            : null,
        ),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await expect(service.reconcile(settings)).rejects.toThrow(
      'MCP tool scope delete_* is not within the reviewed tools for github.',
    );
    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).not.toHaveBeenCalled();
  });

  it('reconciles tool sources separately from capability authority', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [],
        mcpServers: [],
        tools: [{ id: 'browser', kind: 'builtin' }],
      },
      capabilities: [],
    };
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(repositories.tools.replaceAgentToolSources).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            sourceId: 'browser',
            kind: 'builtin',
            status: 'active',
          }),
        ],
      }),
    );
    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        toolBindings: [],
      }),
    );
  });

  it('reconciles exact RunCommand capabilities as readable tool rules', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [
        {
          id: 'RunCommand(/usr/local/bin/acme records append *)',
          version: 'builtin',
        },
      ],
    };
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(repositories.tools.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'RunCommand(/usr/local/bin/acme records append *)',
      }),
    );
    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        toolBindings: [
          expect.objectContaining({
            toolId: expect.stringContaining('tool:permission-rule:'),
          }),
        ],
      }),
    );
  });

  it('reconciles reviewed catalog semantic capabilities from settings', async () => {
    const capability = acmeRecordsAppendCapability();
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [
        {
          id: capability.capabilityId,
          version: 'builtin',
        },
      ],
    };
    const repositories = makeRepositories({
      tools: {
        ...makeRepositories().tools,
        listTools: vi.fn(async () => [
          {
            id: 'tool:read',
            appId: 'default',
            name: 'Read',
            status: 'active',
            selectable: true,
          },
          semanticCapabilityTool(capability),
        ]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await expect(
      service.validateCapabilityReferences(settings),
    ).resolves.toEqual([]);

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        toolBindings: [
          expect.objectContaining({
            toolId: `tool:capability:${capability.capabilityId}`,
          }),
        ],
      }),
    );
    expect(repositories.tools.saveTool).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: `capability:${capability.capabilityId}`,
      }),
    );
  });

  it('rejects generated runtime skill grants during reconciliation', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [{ id: 'linkedin-posting' }],
        mcpServers: [],
        tools: [],
      },
      capabilities: [
        {
          id: 'RunCommand(/Users/tester/gantry/agents/main_agent/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
          version: 'builtin',
        },
      ],
    };
    const skill = linkedinPostingSkill();
    const repositories = makeRepositories({
      skills: {
        ...makeRepositories().skills,
        getSkill: vi.fn(async (id: string) => (id === skill.id ? skill : null)),
        listSkills: vi.fn(async () => [skill]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences.join('\n')).toContain(
      'Persistent RunCommand rules cannot reference generated runtime skill paths',
    );
    expect(repositories.tools.saveTool).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringContaining('.llm-runtime'),
      }),
    );
    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).not.toHaveBeenCalled();
  });

  it('rejects generated runtime skill grants without selected skill action metadata', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [
        {
          id: 'RunCommand(/Users/tester/gantry/agents/main_agent/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
          version: 'builtin',
        },
      ],
    };
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences.join('\n')).toContain(
      'Persistent RunCommand rules cannot reference generated runtime skill paths',
    );
    expect(repositories.tools.saveTool).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringContaining('.llm-runtime'),
      }),
    );
    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).not.toHaveBeenCalled();
  });

  it('rejects duplicate installed skills with the same settings name', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [{ id: 'admin' }],
        mcpServers: [],
        tools: [],
      },
      capabilities: [],
    };
    const repositories = makeRepositories({
      skills: {
        ...makeRepositories().skills,
        listSkills: vi.fn(async () => [
          {
            id: 'skill:first',
            appId: 'default',
            name: 'admin',
            status: 'installed',
            storage: { type: 'local' },
          },
          {
            id: 'skill:second',
            appId: 'default',
            name: 'admin',
            status: 'installed',
            storage: { type: 'local' },
          },
        ]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    const errors = await service.validateCapabilityReferences(settings);

    expect(errors).toEqual([
      'agents.main_agent.sources.skills contains ambiguous skill name: admin matched 2 installed skills; use an exact skill id in settings, such as skill:first, skill:second',
    ]);
  });

  it('accepts exact skill ids when installed skill names are duplicated', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [{ id: 'skill:first' }],
        mcpServers: [],
        tools: [],
      },
      capabilities: [],
    };
    const first = {
      id: 'skill:first',
      appId: 'default',
      name: 'admin',
      status: 'installed',
      storage: { type: 'local' },
    };
    const second = {
      id: 'skill:second',
      appId: 'default',
      name: 'admin',
      status: 'installed',
      storage: { type: 'local' },
    };
    const repositories = makeRepositories({
      skills: {
        ...makeRepositories().skills,
        getSkill: vi.fn(async (id: string) =>
          id === 'skill:first' ? first : null,
        ),
        listSkills: vi.fn(async () => [first, second]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    const errors = await service.validateCapabilityReferences(settings);

    expect(errors).toEqual([]);
  });

  it('rejects exact skill ids that collide by runtime directory before reconcile', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [{ id: 'skill:first' }, { id: 'skill:second' }],
        mcpServers: [],
        tools: [],
      },
      capabilities: [],
    };
    const first = {
      id: 'skill:first',
      appId: 'default',
      name: 'admin',
      status: 'installed',
      storage: { type: 'local' },
    };
    const second = {
      id: 'skill:second',
      appId: 'default',
      name: 'admin',
      status: 'installed',
      storage: { type: 'local' },
    };
    const repositories = makeRepositories({
      skills: {
        ...makeRepositories().skills,
        getSkill: vi.fn(async (id: string) =>
          id === 'skill:first' ? first : id === 'skill:second' ? second : null,
        ),
        listSkills: vi.fn(async () => [first, second]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    const result = await service.reconcile(settings);

    expect(result).toEqual({
      applied: [],
      skipped: [],
      invalidReferences: [
        'agents.main_agent.sources.skills contains selected skills that materialize to the same runtime directory "admin": skill:first, skill:second. Keep only one exact skill id',
      ],
    });
    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).not.toHaveBeenCalled();
  });

  it('treats source skill names as display hints and validates exact ids as authority', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [
          {
            name: 'stale-display-name',
            id: 'skill:first',
          },
        ],
        mcpServers: [],
        tools: [],
      },
      capabilities: [],
    };
    const repositories = makeRepositories({
      skills: {
        ...makeRepositories().skills,
        getSkill: vi.fn(async (id: string) =>
          id === 'skill:first'
            ? {
                id: 'skill:first',
                appId: 'default',
                name: 'admin',
                status: 'installed',
                storage: { type: 'local' },
              }
            : null,
        ),
        listSkills: vi.fn(async () => [
          {
            id: 'skill:other',
            appId: 'default',
            name: 'stale-display-name',
            status: 'installed',
            storage: { type: 'local' },
          },
        ]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    const errors = await service.validateCapabilityReferences(settings);

    expect(errors).toEqual([]);
  });

  it('reconciles desired agents without deleting DB-only bindings in phase 1', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = false;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        primary: {
          jid: 'tg:100',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          requiresTrigger: true,
        },
      },
      sources: emptySources(),
      capabilities: [],
    };
    const ops = makeOps({
      'tg:old': {
        name: 'Old',
        folder: 'old',
        trigger: '@old',
        added_at: '2026-05-01T00:00:00.000Z',
      },
    });
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({ ops, repositories });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    expect(ops.setConversationRoute).toHaveBeenCalledWith(
      'tg:100',
      expect.objectContaining({ folder: 'main_agent', trigger: '@main' }),
    );
    expect(ops.deleteConversationRoute).not.toHaveBeenCalled();
  });

  it('reconciles canonical top-level bindings into registered routing', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack.defaultConnection = 'slack_default';
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    settings.conversations.sales_slack = {
      providerConnection: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales Slack',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
    };
    settings.bindings.sales_slack = {
      agent: 'main_agent',
      conversation: 'sales_slack',
      trigger: '@main',
      addedAt: '2026-05-02T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'conversation',
    };
    const ops = makeOps();
    const service = new SettingsDesiredStateService({
      ops,
      repositories: makeRepositories(),
    });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    expect(ops.setConversationRoute).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        name: 'Sales Slack',
        folder: 'main_agent',
        trigger: '@main',
      }),
    );
  });

  it('persists top-level conversation bindings per agent without id collisions', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack.defaultConnection = 'slack_default';
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    settings.agents.ops_agent = {
      name: 'Ops',
      folder: 'ops_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    settings.conversations.sales = {
      providerConnection: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
    };
    settings.bindings.sales_main = {
      agent: 'main_agent',
      conversation: 'sales',
      trigger: '@main',
      addedAt: '2026-05-02T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'agent',
    };
    settings.bindings.sales_ops = {
      agent: 'ops_agent',
      conversation: 'sales',
      trigger: '@ops',
      addedAt: '2026-05-02T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'conversation',
    };
    const savedConversations: any[] = [];
    const conversations = {
      getConversation: vi.fn(
        async (id: string) =>
          savedConversations.find((conversation) => conversation.id === id) ??
          null,
      ),
      getConversationByExternalRef: vi.fn(async () => null),
      saveConversation: vi.fn(async (conversation: any) => {
        savedConversations.push(conversation);
      }),
      replaceConversationApprovers: vi.fn(async () => []),
    };
    const repositories = makeRepositories({ conversations });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    await service.reconcile(settings);

    const savedBindings =
      repositories.providerConnections.saveAgentConversationBinding.mock.calls.map(
        ([binding]: any[]) => binding,
      );
    expect(savedBindings.map((binding: any) => binding.id).sort()).toEqual([
      'agent-conversation-binding:main_agent:sales_main',
      'agent-conversation-binding:ops_agent:sales_ops',
    ]);
    expect(savedBindings).toContainEqual(
      expect.objectContaining({
        id: 'agent-conversation-binding:main_agent:sales_main',
        agentId: 'agent:main_agent',
        memoryScope: 'agent',
        memorySubject: {
          kind: 'agent',
          appId: 'default',
          agentId: 'agent:main_agent',
        },
      }),
    );
  });

  it('persists user memory subjects for desired-state DM bindings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack.defaultConnection = 'slack_default';
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    settings.conversations.direct_user = {
      providerConnection: 'slack_default',
      externalId: 'U123',
      kind: 'dm',
      displayName: 'Direct User',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
    };
    settings.bindings.direct_user_main = {
      agent: 'main_agent',
      conversation: 'direct_user',
      trigger: '@main',
      addedAt: '2026-05-02T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'user',
    };
    const savedConversations: any[] = [];
    const conversations = {
      getConversation: vi.fn(
        async (id: string) =>
          savedConversations.find((conversation) => conversation.id === id) ??
          null,
      ),
      getConversationByExternalRef: vi.fn(async () => null),
      saveConversation: vi.fn(async (conversation: any) => {
        savedConversations.push(conversation);
      }),
      replaceConversationApprovers: vi.fn(async () => []),
    };
    const repositories = makeRepositories({ conversations });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    await service.reconcile(settings);

    expect(
      repositories.providerConnections.saveAgentConversationBinding,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryScope: 'user',
        memorySubject: {
          kind: 'user',
          appId: 'default',
          userId: 'U123',
        },
      }),
    );
  });

  it('does not report drift for matching canonical top-level bindings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram.defaultConnection = 'telegram_default';
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    settings.conversations.main = {
      providerConnection: 'telegram_default',
      externalId: '-100123',
      kind: 'group',
      displayName: 'Main',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
    };
    settings.bindings.main = {
      agent: 'main_agent',
      conversation: 'main',
      trigger: '@main',
      addedAt: '2026-05-02T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'conversation',
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        'tg:-100123': {
          name: 'Main',
          folder: 'main_agent',
          trigger: '@main',
          added_at: '2026-05-02T00:00:00.000Z',
        },
      }),
      repositories: makeRepositories(),
    });

    await expect(service.drift(settings)).resolves.toMatchObject({
      dbOnlyGroupJids: [],
      missingSettingsAgents: [],
    });
  });

  it('removes absent DB bindings only in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    const ops = makeOps({
      'tg:old': {
        name: 'Old',
        folder: 'old',
        trigger: '@old',
        added_at: '2026-05-01T00:00:00.000Z',
      },
    });
    const service = new SettingsDesiredStateService({
      ops,
      repositories: makeRepositories(),
    });

    await service.reconcile(settings);

    expect(ops.deleteConversationRoute).toHaveBeenCalledWith('tg:old');
  });

  it('clears empty capability selections in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:main_agent',
        toolBindings: [],
        skillBindings: [],
        mcpBindings: [],
      }),
    );
  });

  it('removes DB-only skill bindings in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [{ id: 'skill:admin' }],
        mcpServers: [],
        tools: [],
      },
      capabilities: [],
    };
    const repositories = makeRepositories();
    repositories.skills.listAgentSkillBindings = vi.fn(async () => [
      {
        id: 'agent-skill-binding:agent:main_agent:skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
        appId: 'default',
        agentId: 'agent:main_agent',
        skillId: 'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
        status: 'active',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        skillBindings: [expect.objectContaining({ skillId: 'skill:admin' })],
      }),
    );
  });

  it('does not preserve DB-only skills when visible settings declare capabilities', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = false;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [{ id: 'skill:admin' }],
        mcpServers: [],
        tools: [],
      },
      capabilities: [],
    };
    const repositories = makeRepositories();
    repositories.skills.listAgentSkillBindings = vi.fn(async () => [
      {
        id: 'agent-skill-binding:agent:main_agent:skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
        appId: 'default',
        agentId: 'agent:main_agent',
        skillId: 'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
        status: 'active',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        skillBindings: [expect.objectContaining({ skillId: 'skill:admin' })],
      }),
    );
  });

  it('creates desired conversations before applying approvers without duplicating them', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram.defaultConnection = 'telegram_default';
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.conversations.kai = {
      providerConnection: 'telegram_default',
      externalId: '-100123',
      kind: 'group',
      displayName: 'Kai',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['5759865942'],
    };
    const savedConversations: any[] = [];
    const savedApprovers = new Map<string, string[]>();
    const providerConnection = {
      id: 'telegram_default',
      appId: 'default',
      providerId: 'telegram',
      label: 'Telegram Default',
      status: 'active',
      config: {},
      runtimeSecretRefs: ['TELEGRAM_BOT_TOKEN'],
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    };
    const conversations = {
      getConversation: vi.fn(
        async (id: string) =>
          savedConversations.find((conversation) => conversation.id === id) ??
          null,
      ),
      getConversationByExternalRef: vi.fn(
        async (input: any) =>
          savedConversations.find(
            (conversation) =>
              conversation.providerConnectionId ===
                input.providerConnectionId &&
              conversation.externalRef.value === input.externalConversationId,
          ) ?? null,
      ),
      findConversationByExternalValue: vi.fn(
        async (input: any) =>
          savedConversations.find(
            (conversation) =>
              conversation.externalRef.value === input.externalConversationId,
          ) ?? null,
      ),
      saveConversation: vi.fn(async (conversation: any) => {
        savedConversations.push(conversation);
      }),
      listConversationApprovers: vi.fn(async (conversationId: string) =>
        (savedApprovers.get(conversationId) ?? []).map((externalUserId) => ({
          id: `approver:${externalUserId}`,
          appId: 'default',
          conversationId,
          externalUserId,
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        })),
      ),
      replaceConversationApprovers: vi.fn(async (input: any) => {
        savedApprovers.set(input.conversationId, input.externalUserIds);
        return input.externalUserIds.map((externalUserId: string) => ({
          id: `approver:${externalUserId}`,
          appId: input.appId,
          conversationId: input.conversationId,
          externalUserId,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        }));
      }),
      listParticipantExternalUserIds: vi.fn(async () => ['5759865942']),
    };
    const repositories = makeRepositories({
      conversations,
      providerConnections: {
        getProviderConnection: vi.fn(async (id: string) =>
          id === 'telegram_default' ? providerConnection : null,
        ),
        saveProviderConnection: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    const result = await service.reconcile(settings);

    expect(result.skipped).not.toContain(
      'conversation_approvers:kai:not-found',
    );
    expect(
      repositories.providerConnections.saveProviderConnection,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'telegram_default',
        providerId: 'telegram',
        runtimeSecretRefs: ['TELEGRAM_BOT_TOKEN'],
      }),
    );
    expect(conversations.saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation:tg:-100123',
        providerConnectionId: 'telegram_default',
        externalRef: { kind: 'conversation', value: '-100123' },
        kind: 'group',
      }),
    );
    expect(conversations.replaceConversationApprovers).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation:tg:-100123',
        externalUserIds: ['5759865942'],
      }),
    );

    await service.reconcile(settings);

    expect(conversations.saveConversation).toHaveBeenCalledTimes(1);
    expect(conversations.replaceConversationApprovers).toHaveBeenCalledTimes(2);

    const administration = new ConversationAdministrationService(
      repositories as never,
      {
        validateControlApprovers: vi.fn(async (input) => ({
          validUserIds: input.userIds,
          invalidUserIds: [],
        })),
      },
    );
    await expect(
      administration.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'telegram' as never,
        conversationJid: 'telegram:-100123',
        userId: '5759865942',
      }),
    ).resolves.toBe(true);
  });

  it('reconciles one agent with conversation approvers', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack.defaultConnection = 'slack_default';
    settings.providers.teams.enabled = true;
    settings.providers.teams.defaultConnection = 'teams_default';
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    settings.providerConnections.teams_default = {
      provider: 'teams',
      label: 'Teams Default',
      runtimeSecretRefs: { client_id: 'TEAMS_CLIENT_ID' },
    };
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        slack_sales: {
          jid: 'slack:C123',
          name: 'Sales Slack',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          requiresTrigger: true,
        },
        teams_sales: {
          jid: 'teams:19:channel@thread.tacv2',
          name: 'Sales Teams',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          requiresTrigger: true,
        },
      },
      sources: emptySources(),
      capabilities: [],
    };
    settings.conversations.sales_slack = {
      providerConnection: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales Slack',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['U123'],
    };
    settings.conversations.sales_teams = {
      providerConnection: 'teams_default',
      externalId: '19:channel@thread.tacv2',
      kind: 'channel',
      displayName: 'Sales Teams',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['8:orgid:abc'],
    };
    const savedConversations: any[] = [];
    const savedApprovers = new Map<string, string[]>();
    const conversations = {
      getConversation: vi.fn(
        async (id: string) =>
          savedConversations.find((conversation) => conversation.id === id) ??
          null,
      ),
      getConversationByExternalRef: vi.fn(
        async (input: any) =>
          savedConversations.find(
            (conversation) =>
              conversation.providerConnectionId ===
                input.providerConnectionId &&
              conversation.externalRef.value === input.externalConversationId,
          ) ?? null,
      ),
      findConversationByExternalValue: vi.fn(
        async (input: any) =>
          savedConversations.find(
            (conversation) =>
              conversation.externalRef.value === input.externalConversationId,
          ) ?? null,
      ),
      saveConversation: vi.fn(async (conversation: any) => {
        savedConversations.push(conversation);
      }),
      replaceConversationApprovers: vi.fn(async (input: any) => {
        savedApprovers.set(input.conversationId, input.externalUserIds);
        return input.externalUserIds.map((externalUserId: string) => ({
          id: `approver:${input.conversationId}:${externalUserId}`,
          appId: input.appId,
          conversationId: input.conversationId,
          externalUserId,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        }));
      }),
      listParticipantExternalUserIds: vi.fn(async (conversationId: string) =>
        conversationId.includes('sl:C123') ? ['U123'] : ['8:orgid:abc'],
      ),
    };
    const repositories = makeRepositories({
      conversations,
      providerConnections: {
        getProviderConnection: vi.fn(async (id: string) => ({
          id,
          appId: 'default',
          providerId: id === 'slack_default' ? 'slack' : 'teams',
          label: id,
          status: 'active',
          config: {},
          runtimeSecretRefs: [],
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        })),
        saveProviderConnection: vi.fn(async () => undefined),
        saveAgentConversationBinding: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    const result = await service.reconcile(settings);

    expect(result.applied).toEqual(
      expect.arrayContaining([
        'conversation_approvers:sales_slack',
        'conversation_approvers:sales_teams',
      ]),
    );
    expect(savedApprovers).toEqual(
      new Map([
        ['conversation:sl:C123', ['U123']],
        ['conversation:teams:19:channel@thread.tacv2', ['8:orgid:abc']],
      ]),
    );
  });

  it('does not rewrite another provider conversation when external IDs collide', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram.defaultConnection = 'telegram_default';
    settings.providers.slack.enabled = true;
    settings.providers.slack.defaultConnection = 'slack_default';
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    settings.conversations.telegram_conflict = {
      providerConnection: 'telegram_default',
      externalId: 'C123',
      kind: 'group',
      displayName: 'Telegram C123',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['5759865942'],
    };
    const slackConversation = {
      id: 'conversation:sl:C123',
      appId: 'default',
      providerConnectionId: 'slack_default',
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'Slack C123',
      status: 'active',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    const savedConversations: any[] = [slackConversation];
    const conversations = {
      getConversation: vi.fn(
        async (id: string) =>
          savedConversations.find((conversation) => conversation.id === id) ??
          null,
      ),
      getConversationByExternalRef: vi.fn(
        async (input: any) =>
          savedConversations.find(
            (conversation) =>
              conversation.providerConnectionId ===
                input.providerConnectionId &&
              conversation.externalRef.value === input.externalConversationId,
          ) ?? null,
      ),
      findConversationByExternalValue: vi.fn(async () => slackConversation),
      saveConversation: vi.fn(async (conversation: any) => {
        savedConversations.push(conversation);
      }),
      replaceConversationApprovers: vi.fn(async (input: any) =>
        input.externalUserIds.map((externalUserId: string) => ({
          conversationId: input.conversationId,
          externalUserId,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        })),
      ),
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories: makeRepositories({ conversations }),
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    await service.reconcile(settings);

    expect(
      conversations.findConversationByExternalValue,
    ).not.toHaveBeenCalled();
    expect(conversations.saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation:tg:C123',
        providerConnectionId: 'telegram_default',
        title: 'Telegram C123',
      }),
    );
    expect(conversations.saveConversation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation:sl:C123',
        providerConnectionId: 'telegram_default',
      }),
    );
  });

  it('skips settings approvers that are not known conversation members', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack.defaultConnection = 'slack_default';
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    settings.conversations.sales = {
      providerConnection: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['U-NOT-MEMBER'],
    };
    const savedConversations: any[] = [];
    const conversations = {
      getConversation: vi.fn(
        async (id: string) =>
          savedConversations.find((conversation) => conversation.id === id) ??
          null,
      ),
      getConversationByExternalRef: vi.fn(async () => null),
      saveConversation: vi.fn(async (conversation: any) => {
        savedConversations.push(conversation);
      }),
      listParticipantExternalUserIds: vi.fn(async () => ['U-MEMBER']),
      replaceConversationApprovers: vi.fn(async () => []),
      listConversationApprovers: vi.fn(async () => []),
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories: makeRepositories({ conversations }),
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    const result = await service.reconcile(settings);

    expect(conversations.replaceConversationApprovers).not.toHaveBeenCalled();
    expect(result.skipped.join('\n')).toContain(
      'Control approvers must be members of the conversation.',
    );
  });

  it('exports colliding conversation bindings without overwriting one another', async () => {
    const settings = createDefaultRuntimeSettings();
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        'tg abc': {
          name: 'A',
          folder: 'main_agent',
          trigger: '@a',
          added_at: '2026-05-01T00:00:00.000Z',
        },
        'tg/abc': {
          name: 'B',
          folder: 'main_agent',
          trigger: '@b',
          added_at: '2026-05-01T00:00:00.000Z',
        },
      }),
      repositories: makeRepositories(),
    });

    const exported = await service.exportCurrent(settings);
    const bindingJids = Object.values(exported.agents.main_agent.bindings).map(
      (binding) => binding.jid,
    );

    expect(bindingJids.sort()).toEqual(['tg abc', 'tg/abc']);
    expect(Object.keys(exported.agents.main_agent.bindings)).toHaveLength(2);
  });

  it('exports desired state with batched agent and conversation reads', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack = {
      enabled: true,
      defaultConnection: 'slack_default',
    };
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Slack',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    const storedConversation = {
      id: 'conversation:sl:C100',
      appId: 'default',
      providerConnectionId: 'slack_default',
      externalRef: { kind: 'conversation', value: 'C100' },
      kind: 'channel',
      title: 'Slack C100',
      status: 'active',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    const repositories = makeRepositories({
      agents: {
        ...makeRepositories().agents,
      },
      tools: {
        ...makeRepositories().tools,
        listAgentToolBindings: vi.fn(async () => {
          throw new Error('single-agent tool read should not run');
        }),
        listAgentToolBindingsForAgents: vi.fn(async () => []),
      },
      skills: {
        ...makeRepositories().skills,
        listAgentSkillBindings: vi.fn(async () => {
          throw new Error('single-agent skill read should not run');
        }),
        listAgentSkillBindingsForAgents: vi.fn(async () => []),
      },
      mcpServers: {
        ...makeRepositories().mcpServers,
        listAgentBindings: vi.fn(async () => {
          throw new Error('single-agent MCP read should not run');
        }),
        listAgentBindingsForAgents: vi.fn(async () => []),
      },
      conversations: {
        listConversations: vi.fn(async () => [storedConversation]),
        listConversationApprovers: vi.fn(async () => {
          throw new Error('single-conversation approver read should not run');
        }),
        listConversationApproversForConversations: vi.fn(async () => [
          {
            conversationId: storedConversation.id,
            externalUserId: '5759865942',
          },
        ]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        'sl:C100': {
          name: 'Main Slack',
          folder: 'main_agent',
          trigger: '@main',
          added_at: '2026-05-01T00:00:00.000Z',
          requiresTrigger: false,
        },
        'sl:C200': {
          name: 'Side Slack',
          folder: 'side_agent',
          trigger: '@side',
          added_at: '2026-05-01T00:00:00.000Z',
        },
      }),
      repositories,
    });

    const exported = await service.exportCurrent(settings);

    expect(
      repositories.conversations.listConversationApproversForConversations,
    ).toHaveBeenCalledTimes(1);
    expect(exported.conversations.main_agent_slack.controlApprovers).toEqual([
      '5759865942',
    ]);
  });

  it('does not borrow exported approvers from another provider external ID collision', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram = {
      enabled: true,
      defaultConnection: 'telegram_default',
    };
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    const slackConversation = {
      id: 'conversation:sl:-100123',
      appId: 'default',
      providerConnectionId: 'slack_default',
      externalRef: { kind: 'conversation', value: '-100123' },
      kind: 'channel',
      title: 'Slack -100123',
      status: 'active',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    const conversations = {
      listConversations: vi.fn(async () => [slackConversation]),
      getConversationByExternalRef: vi.fn(async () => null),
      getConversation: vi.fn(async () => null),
      findConversationByExternalValue: vi.fn(async () => slackConversation),
      listConversationApprovers: vi.fn(async () => [
        {
          conversationId: slackConversation.id,
          externalUserId: 'U123',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ]),
      listConversationApproversForConversations: vi.fn(async () => [
        {
          conversationId: slackConversation.id,
          externalUserId: 'U123',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ]),
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        'tg:-100123': {
          name: 'Telegram Group',
          folder: 'main_agent',
          trigger: '@Default Agent',
          added_at: '2026-05-01T00:00:00.000Z',
          requiresTrigger: false,
        },
      }),
      repositories: makeRepositories({ conversations }),
    });

    const exported = await service.exportCurrent(settings);

    expect(
      conversations.findConversationByExternalValue,
    ).not.toHaveBeenCalled();
    expect(exported.conversations.main_agent_telegram).toEqual(
      expect.objectContaining({
        providerConnection: 'telegram_default',
        externalId: '-100123',
        controlApprovers: [],
      }),
    );
  });

  it('exports canonical provider conversations without duplicate settings entries', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram = {
      enabled: true,
      defaultConnection: 'telegram_default',
    };
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.conversations.main_agent_telegram = {
      providerConnection: 'telegram_default',
      externalId: '-100123',
      kind: 'group',
      displayName: 'Generated Group',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
    };
    settings.conversations.main_telegram_group = {
      providerConnection: 'telegram_default',
      externalId: '-100123',
      kind: 'group',
      displayName: 'Default Agent Telegram Group',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['5759865942'],
    };
    settings.bindings.main_agent_telegram = {
      agent: 'main_agent',
      conversation: 'main_agent_telegram',
      trigger: '@Default Agent',
      addedAt: '2026-05-01T00:00:00.000Z',
      requiresTrigger: false,
      memoryScope: 'conversation',
    };
    settings.bindings.main_telegram_group = {
      agent: 'main_agent',
      conversation: 'main_telegram_group',
      trigger: '@Default Agent',
      addedAt: '2026-05-01T00:00:00.000Z',
      requiresTrigger: false,
      memoryScope: 'conversation',
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        'tg:-100123': {
          name: 'Default Agent Telegram Group',
          folder: 'main_agent',
          trigger: '@Default Agent',
          added_at: '2026-05-01T00:00:00.000Z',
          requiresTrigger: false,
        },
      }),
      repositories: makeRepositories(),
    });

    const exported = await service.exportCurrent(settings);

    const exportedConversations = Object.entries(exported.conversations).filter(
      ([, conversation]) =>
        conversation.providerConnection === 'telegram_default' &&
        conversation.externalId === '-100123',
    );
    expect(exportedConversations).toEqual([
      [
        'main_telegram_group',
        expect.objectContaining({
          controlApprovers: ['5759865942'],
          displayName: 'Default Agent Telegram Group',
        }),
      ],
    ]);
    expect(Object.values(exported.bindings)).toEqual([
      expect.objectContaining({ conversation: 'main_telegram_group' }),
    ]);
  });

  it('exports active agents, capabilities, conversations, approvers, and bindings from projection', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.side_agent = {
      name: 'Stale Side',
      folder: 'side_agent',
      persona: 'research',
      model: 'sonnet',
      bindings: {},
      sources: {
        skills: [{ id: 'stale-skill' }],
        mcpServers: [],
        tools: [],
      },
      capabilities: [{ id: 'stale-tool', version: 'builtin' }],
    };
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Old Slack Label',
      runtimeSecretRefs: {
        bot_token: 'SLACK_BOT_TOKEN',
        app_token: 'SLACK_APP_TOKEN',
      },
    };
    settings.conversations.sales = {
      providerConnection: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales',
      senderPolicy: { allow: ['U111'], mode: 'always' },
      controlApprovers: ['STALE'],
    };
    settings.bindings.side_sales = {
      agent: 'side_agent',
      conversation: 'sales',
      trigger: '@old',
      addedAt: '2026-05-01T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'conversation',
      model: 'haiku',
    };
    settings.bindings.stale = {
      agent: 'side_agent',
      conversation: 'missing',
      trigger: '@stale',
      addedAt: '2026-05-01T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'conversation',
    };
    const storedConversation = {
      id: 'conversation:sl:C123',
      appId: 'default',
      providerConnectionId: 'slack_default',
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'Sales Channel',
      status: 'active',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    const repositories = makeRepositories({
      agents: {
        ...makeRepositories().agents,
        listAgents: vi.fn(async () => [
          {
            id: 'agent:side_agent',
            appId: 'default',
            name: 'Side',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
      providerConnections: {
        ...makeRepositories().providerConnections,
        listProviderConnections: vi.fn(async () => [
          {
            id: 'slack_default',
            appId: 'default',
            providerId: 'slack',
            label: 'Slack Workspace',
            status: 'active',
            config: {},
            runtimeSecretRefs: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
        listAgentConversationBindings: vi.fn(async () => [
          {
            id: 'binding:side_sales',
            appId: 'default',
            agentId: 'agent:side_agent',
            providerConnectionId: 'slack_default',
            conversationId: storedConversation.id,
            displayName: 'Sales Channel',
            status: 'active',
            triggerMode: 'keyword',
            triggerPattern: '@side',
            requiresTrigger: true,
            memoryScope: 'conversation',
            memorySubject: { kind: 'conversation' },
            permissionPolicyIds: [],
            createdAt: '2026-05-02T00:00:00.000Z',
            updatedAt: '2026-05-02T00:00:00.000Z',
          },
        ]),
      },
      conversations: {
        listConversations: vi.fn(async () => [storedConversation]),
        listConversationApproversForConversations: vi.fn(async () => [
          {
            conversationId: storedConversation.id,
            externalUserId: 'U999',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
      tools: {
        ...makeRepositories().tools,
        listAgentToolBindingsForAgents: vi.fn(async () => [
          {
            id: 'agent-tool-binding:side-read',
            appId: 'default',
            agentId: 'agent:side_agent',
            toolId: 'tool:read',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
        listAgentToolSourcesForAgents: vi.fn(async () => [
          {
            id: 'agent-tool-source:side-browser',
            appId: 'default',
            agentId: 'agent:side_agent',
            sourceId: 'browser',
            kind: 'builtin',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
      skills: {
        ...makeRepositories().skills,
        listSkills: vi.fn(async () => [
          {
            id: 'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
            appId: 'default',
            name: 'custom-skill',
            status: 'installed',
            storage: { type: 'local' },
          },
        ]),
        listAgentSkillBindingsForAgents: vi.fn(async () => [
          {
            id: 'agent-skill-binding:side-custom',
            appId: 'default',
            agentId: 'agent:side_agent',
            skillId: 'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
      mcpServers: {
        ...makeRepositories().mcpServers,
        listAgentBindingsForAgents: vi.fn(async () => [
          {
            id: 'agent-mcp-binding:side-github',
            appId: 'default',
            agentId: 'agent:side_agent',
            serverId: 'mcp:github',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    const exported = await service.exportCurrent(settings);

    expect(exported.agents.side_agent).toEqual(
      expect.objectContaining({
        name: 'Side',
        persona: 'research',
        model: 'sonnet',
        sources: {
          skills: [
            {
              name: 'custom-skill',
              id: 'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
            },
          ],
          mcpServers: [{ id: 'mcp:github' }],
          tools: [{ id: 'browser', kind: 'builtin' }],
        },
        capabilities: [{ id: 'Read', version: 'builtin' }],
      }),
    );
    expect(exported.providerConnections.slack_default).toEqual({
      provider: 'slack',
      label: 'Slack Workspace',
      runtimeSecretRefs: {
        bot_token: 'SLACK_BOT_TOKEN',
        app_token: 'SLACK_APP_TOKEN',
      },
    });
    expect(exported.conversations.sales).toEqual(
      expect.objectContaining({
        displayName: 'Sales',
        senderPolicy: { allow: ['U111'], mode: 'always' },
        controlApprovers: ['U999'],
      }),
    );
    expect(exported.bindings.side_sales).toEqual(
      expect.objectContaining({
        trigger: '@side',
        addedAt: '2026-05-02T00:00:00.000Z',
        model: 'haiku',
      }),
    );
    expect(exported.bindings.stale).toBeUndefined();
  });

  it('rejects generated runtime skill command grants during export', async () => {
    const settings = createDefaultRuntimeSettings();
    const skill = {
      id: 'skill:linkedin',
      appId: 'default',
      name: 'linkedin-posting',
      status: 'installed',
      source: 'admin_uploaded',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      storage: {
        storageType: 'local-filesystem',
        storageRef: '/skills/linkedin-posting',
        contentHash: 'sha256:linkedin-posting-v3',
        sizeBytes: 10,
      },
      actionPermissions: [
        {
          id: 'publish',
          capabilityId: 'skill.linkedin-posting.publish',
          displayName: 'LinkedIn posting',
          risk: 'write',
          can: 'Publish a prepared LinkedIn post through the approved script.',
          cannot:
            'Read unrelated accounts or receive raw LinkedIn credentials.',
          requiredEnvVars: ['LINKEDIN_ACCESS_TOKEN'],
          commandTemplates: ['skills/linkedin-posting/post.py *'],
        },
      ],
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    const repositories = makeRepositories({
      agents: {
        ...makeRepositories().agents,
        listAgents: vi.fn(async () => [
          {
            id: 'agent:main_agent',
            appId: 'default',
            name: 'Main',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
      tools: {
        ...makeRepositories().tools,
        listTools: vi.fn(async () => [
          {
            id: 'tool:generated-skill-command',
            appId: 'default',
            name: 'RunCommand(/tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
            status: 'active',
            selectable: true,
          },
        ]),
        listAgentToolBindingsForAgents: vi.fn(async () => [
          {
            id: 'agent-tool-binding:generated-skill-command',
            appId: 'default',
            agentId: 'agent:main_agent',
            toolId: 'tool:generated-skill-command',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
      skills: {
        ...makeRepositories().skills,
        listSkills: vi.fn(async () => [skill]),
        listAgentSkillBindingsForAgents: vi.fn(async () => [
          {
            id: 'agent-skill-binding:linkedin',
            appId: 'default',
            agentId: 'agent:main_agent',
            skillId: 'skill:linkedin',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await expect(service.exportCurrent(settings)).rejects.toThrow(
      'Persistent RunCommand rules cannot reference generated runtime skill paths',
    );
  });

  it('rejects generated runtime skill command grants without selected action metadata', async () => {
    const settings = createDefaultRuntimeSettings();
    const repositories = makeRepositories({
      agents: {
        ...makeRepositories().agents,
        listAgents: vi.fn(async () => [
          {
            id: 'agent:main_agent',
            appId: 'default',
            name: 'Main',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
      tools: {
        ...makeRepositories().tools,
        listTools: vi.fn(async () => [
          {
            id: 'tool:generated-skill-command',
            appId: 'default',
            name: 'RunCommand(/tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
            status: 'active',
            selectable: true,
          },
        ]),
        listAgentToolBindingsForAgents: vi.fn(async () => [
          {
            id: 'agent-tool-binding:generated-skill-command',
            appId: 'default',
            agentId: 'agent:main_agent',
            toolId: 'tool:generated-skill-command',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await expect(service.exportCurrent(settings)).rejects.toThrow(
      'Persistent RunCommand rules cannot reference generated runtime skill paths',
    );
  });

  it('disables DB-only agents and clears their policies in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    const repositories = makeRepositories({
      agents: {
        saveAgent: vi.fn(async () => undefined),
        listAgents: vi.fn(async () => [
          {
            id: 'agent:old_agent',
            appId: 'default',
            name: 'Old',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
        replaceAgentCapabilityBindings: vi.fn(async () => undefined),
        disableAgent: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(repositories.agents.disableAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:old_agent' }),
    );
  });

  it('classifies topology changes as restart-required', () => {
    const before = createDefaultRuntimeSettings();
    const after = createDefaultRuntimeSettings();
    after.agent.defaultModel = 'sonnet';
    after.providers.telegram.enabled = !before.providers.telegram.enabled;

    expect(classifySettingsChanges(before, after)).toEqual({
      liveApplied: ['agent_defaults'],
      restartRequired: ['providers'],
    });
  });

  it('classifies agent capability and memory changes as restart-required', () => {
    const before = createDefaultRuntimeSettings();
    const after = createDefaultRuntimeSettings();
    after.memory.enabled = false;
    after.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [{ id: 'Read', version: 'builtin' }],
    };

    expect(classifySettingsChanges(before, after)).toEqual({
      liveApplied: [],
      restartRequired: ['agents', 'memory'],
    });
  });
});
