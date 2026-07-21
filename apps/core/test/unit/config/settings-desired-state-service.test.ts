import { describe, expect, it, vi } from 'vitest';

import {
  classifySettingsChanges,
  SettingsDesiredStateService,
} from '@core/config/settings/desired-state-service.js';
import {
  createDefaultRuntimeSettings,
  parseRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { configuredRoutingBindings } from '@core/config/settings/desired-state-service-helpers.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
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
  const providerAccounts = {
    getProviderAccount: vi.fn(async (id: string) => ({
      id,
      appId: 'default',
      agentId: 'main_agent',
      providerId: id.replace(/_default$/, ''),
      label: id,
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    })),
    saveProviderAccount: vi.fn(async () => undefined),
    listProviderAccounts: vi.fn(async () => []),
    disableProviderAccount: vi.fn(async () => undefined),
    saveConversationInstall: vi.fn(async () => undefined),
    listConversationInstalls: vi.fn(async () => []),
    disableConversationInstall: vi.fn(async () => undefined),
    getConversationInstall: vi.fn(async () => null),
    listConversationInstallsByConversation: vi.fn(async () => []),
    isAgentEnabledInConversation: vi.fn(async () => false),
  };
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
    providerAccounts,
    ...overrides,
  } as any;
}

function makeOps(
  groups: Record<string, any> = {},
  chats: Array<{ jid: string; is_group?: number }> = [],
) {
  return {
    getAllConversationRoutes: vi.fn(async () => groups),
    getAllChats: vi.fn(async () => chats),
    setConversationRoute: vi.fn(async () => undefined),
    deleteConversationRoute: vi.fn(async () => undefined),
  };
}

describe('SettingsDesiredStateService', () => {
  it('derives canonical route conversation ids instead of using settings keys', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: {},
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
      providerAccount: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales Slack',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {},
    };
    settings.bindings.sales_slack = {
      agent: 'main_agent',
      conversation: 'sales_slack',
      trigger: '@main',
      addedAt: '2026-05-02T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'conversation',
    };

    expect(configuredRoutingBindings(settings)[0]).toMatchObject({
      conversationId: 'conversation:slack_default:sl:C123',
      jid: 'sl:C123',
      providerAccountId: 'slack_default',
    });
  });

  it('preserves existing legacy conversation ids across both route projections, including unprefixed agent keys', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: {},
    };
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        sales: {
          jid: 'sl:C123',
          providerAccountId: 'slack_default',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          requiresTrigger: true,
        },
      },
      sources: emptySources(),
      capabilities: [],
    };
    settings.agents.side_agent = {
      name: 'Side',
      folder: 'side_agent',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
    };
    settings.conversations.sales_settings_key = {
      providerConnection: 'slack_default',
      providerAccount: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales Slack',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {
        main_agent: {
          agentId: 'main_agent',
          providerAccountId: 'slack_default',
          status: 'active',
          addedAt: '2026-05-02T00:00:00.000Z',
          memoryScope: 'conversation',
        },
      },
    };
    settings.conversations.support_settings_key = {
      providerConnection: 'slack_default',
      providerAccount: 'slack_default',
      externalId: 'C456',
      kind: 'channel',
      displayName: 'Support Slack',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {},
    };
    settings.bindings.support = {
      agent: 'side_agent',
      conversation: 'support_settings_key',
      trigger: '@side',
      addedAt: '2026-05-02T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'conversation',
    };
    const mainRouteKey = makeAgentThreadQueueKey(
      'sl:C123',
      'main_agent',
      undefined,
      'slack_default',
    );
    const normalizedMainRouteKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:main_agent',
      undefined,
      'slack_default',
    );
    const sideRouteKey = makeAgentThreadQueueKey(
      'sl:C456',
      'agent:side_agent',
      undefined,
      'slack_default',
    );
    const routes: Record<string, any> = {
      [mainRouteKey]: {
        name: 'Main',
        folder: 'main_agent',
        conversationId: 'sales_slack',
        trigger: '@main',
        added_at: '2026-05-02T00:00:00.000Z',
        requiresTrigger: true,
        providerAccountId: 'slack_default',
        conversationKind: 'channel',
      },
      [sideRouteKey]: {
        name: 'Side',
        folder: 'side_agent',
        conversationId: 'support_slack',
        trigger: '@side',
        added_at: '2026-05-02T00:00:00.000Z',
        requiresTrigger: true,
        providerAccountId: 'slack_default',
        conversationKind: 'channel',
      },
    };
    const routeChanges: string[] = [];
    const ops = {
      ...makeOps(),
      getAllConversationRoutes: vi.fn(async () => ({ ...routes })),
      setConversationRoute: vi.fn(async (jid: string, route: any) => {
        if (JSON.stringify(routes[jid]) !== JSON.stringify(route)) {
          routeChanges.push(jid);
          routes[jid] = route;
        }
      }),
    };

    expect(
      configuredRoutingBindings(settings, routes).map(
        (binding) => binding.conversationId,
      ),
    ).toEqual(['sales_slack', 'support_slack']);

    const service = new SettingsDesiredStateService({
      ops,
      repositories: makeRepositories(),
    });
    await service.reconcile(settings);
    await service.reconcile(settings);

    expect(routeChanges).toEqual([normalizedMainRouteKey]);
    expect(routes[mainRouteKey]?.conversationId).toBe('sales_slack');
    expect(routes[normalizedMainRouteKey]?.conversationId).toBe('sales_slack');
    expect(routes[sideRouteKey]?.conversationId).toBe('support_slack');
    expect(Object.values(routes)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: 'sales_settings_key' }),
        expect.objectContaining({ conversationId: 'support_settings_key' }),
      ]),
    );
  });

  it('deduplicates explicit and inferred provider accounts for one route identity', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: {},
    };
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        explicit: {
          jid: 'sl:C123',
          providerAccountId: 'slack_default',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          requiresTrigger: true,
        },
        inferred: {
          jid: 'sl:C123',
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
      providerAccount: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales Slack',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {},
    };

    expect(configuredRoutingBindings(settings)).toEqual([
      expect.objectContaining({
        agentFolder: 'main_agent',
        jid: 'sl:C123',
        providerAccountId: 'slack_default',
        conversationId: 'conversation:slack_default:sl:C123',
      }),
    ]);
  });

  it('rejects a directly keyed install for another thread and finds the matching install', () => {
    const settings = createDefaultRuntimeSettings();
    for (const providerAccountId of [
      'slack_default',
      'slack_wrong',
      'slack_correct',
    ]) {
      settings.providerAccounts[providerAccountId] = {
        agentId: 'main_agent',
        provider: 'slack',
        label: providerAccountId,
        runtimeSecretRefs: {},
      };
    }
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        support_thread: {
          jid: 'sl:C123',
          threadId: 'thread-correct',
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
      providerAccount: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales Slack',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {
        main_agent: {
          agentId: 'main_agent',
          providerAccountId: 'slack_wrong',
          threadId: 'thread-wrong',
          status: 'active',
          addedAt: '2026-05-02T00:00:00.000Z',
          memoryScope: 'conversation',
        },
        main_agent_correct_thread: {
          agentId: 'main_agent',
          providerAccountId: 'slack_correct',
          threadId: ' thread-correct ',
          status: 'active',
          addedAt: '2026-05-02T00:00:00.000Z',
          memoryScope: 'conversation',
        },
      },
    };

    expect(configuredRoutingBindings(settings)).toEqual([
      expect.objectContaining({
        agentFolder: 'main_agent',
        threadId: 'thread-correct',
        providerAccountId: 'slack_correct',
        conversationId: 'conversation:slack_correct:sl:C123',
      }),
    ]);
  });

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
          ['requires' + 'Trigger']: true,
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
      makeAgentThreadQueueKey('tg:100', 'agent:main_agent'),
      expect.objectContaining({ folder: 'main_agent', trigger: '@main' }),
    );
    expect(ops.deleteConversationRoute).not.toHaveBeenCalled();
  });

  it('reconciles canonical top-level bindings into registered routing', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack['default' + 'Connection'] = 'slack_default';
    settings.providerAccounts.slack_default = {
      agentId: 'main_agent',
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
      providerAccount: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales Slack',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {},
    };
    settings.bindings.sales_slack = {
      agent: 'main_agent',
      conversation: 'sales_slack',
      trigger: '@main',
      addedAt: '2026-05-02T00:00:00.000Z',
      ['requires' + 'Trigger']: true,
      memoryScope: 'conversation',
    };
    const ops = makeOps();
    const service = new SettingsDesiredStateService({
      ops,
      repositories: makeRepositories(),
    });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    expect(ops.setConversationRoute).toHaveBeenCalledTimes(1);
    expect(ops.setConversationRoute).toHaveBeenCalledWith(
      makeAgentThreadQueueKey(
        'sl:C123',
        'agent:main_agent',
        undefined,
        'slack_default',
      ),
      expect.objectContaining({
        name: 'Main',
        folder: 'main_agent',
        conversationId: 'conversation:slack_default:sl:C123',
        trigger: '@main',
        providerAccountId: 'slack_default',
      }),
    );
  });

  it('projects provider account into desired-state route identity', async () => {
    const settings = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  main_agent:
    name: Main
provider_accounts:
  slack_one:
    agent: main_agent
    provider: slack
    label: Slack One
  slack_two:
    agent: main_agent
    provider: slack
    label: Slack Two
conversations:
  sales_one:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: Sales One
    installed_agents:
      main_agent:
        provider_account: slack_one
        trigger: "@main"
  sales_two:
    provider_account: slack_two
    id: slack:C123
    type: channel
    display_name: Sales Two
    installed_agents:
      main_agent:
        provider_account: slack_two
        trigger: "@main"
`);
    const ops = makeOps();
    const repositories = makeRepositories({
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        getProviderAccount: vi.fn(async (id: string) => ({
          id,
          appId: 'default',
          agentId: 'agent:main_agent',
          providerId: 'slack',
          label: id,
          status: 'active',
          config: {},
          runtimeSecretRefs: {},
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        })),
      },
      conversations: {
        getConversation: vi.fn(async () => null),
        getConversationByExternalRef: vi.fn(async () => null),
        saveConversation: vi.fn(async () => undefined),
        replaceConversationApprovers: vi.fn(async () => []),
      },
    });
    const service = new SettingsDesiredStateService({
      ops,
      repositories,
    });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    expect(ops.setConversationRoute).toHaveBeenCalledWith(
      makeAgentThreadQueueKey(
        'sl:slack:C123',
        'agent:main_agent',
        undefined,
        'slack_one',
      ),
      expect.objectContaining({
        conversationId: 'conversation:slack_one:sl:slack:C123',
        providerAccountId: 'slack_one',
      }),
    );
    expect(ops.setConversationRoute).toHaveBeenCalledWith(
      makeAgentThreadQueueKey(
        'sl:slack:C123',
        'agent:main_agent',
        undefined,
        'slack_two',
      ),
      expect.objectContaining({
        conversationId: 'conversation:slack_two:sl:slack:C123',
        providerAccountId: 'slack_two',
      }),
    );
    expect(repositories.conversations.saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation:slack_one:sl:slack:C123',
        providerAccountId: 'slack_one',
      }),
    );
    expect(repositories.conversations.saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation:slack_two:sl:slack:C123',
        providerAccountId: 'slack_two',
      }),
    );
  });

  it('does not derive conversation identity from another provider account', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providerAccounts.slack_one = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack One',
      runtimeSecretRefs: {},
    };
    settings.providerAccounts.slack_two = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack Two',
      runtimeSecretRefs: {},
    };
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        primary: {
          jid: 'sl:slack:C123',
          providerAccountId: 'slack_two',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          requiresTrigger: true,
        },
      },
      sources: emptySources(),
      capabilities: [],
    };
    settings.conversations.sales_one = {
      providerConnection: 'slack_one',
      providerAccount: 'slack_one',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales One',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {
        main_agent: {
          agentId: 'main_agent',
          providerAccountId: 'slack_one',
          status: 'active',
          addedAt: '2026-05-02T00:00:00.000Z',
          memoryScope: 'conversation',
        },
      },
    };

    expect(configuredRoutingBindings(settings)[0]).toMatchObject({
      agentFolder: 'main_agent',
      providerAccountId: 'slack_two',
      conversationId: 'conversation:slack_two:sl:slack:C123',
    });
  });

  it('saves provider accounts before routes create provider-account stubs', async () => {
    const settings = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  main_agent:
    name: Main
provider_accounts:
  slack_one:
    agent: main_agent
    provider: slack
    label: Slack One
  slack_two:
    agent: main_agent
    provider: slack
    label: Slack Two
conversations:
  sales_one:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: Sales One
    installed_agents:
      main_agent:
        provider_account: slack_one
        trigger: "@main"
  sales_two:
    provider_account: slack_two
    id: slack:C456
    type: channel
    display_name: Sales Two
    installed_agents:
      main_agent:
        provider_account: slack_two
        trigger: "@main"
`);
    const ops = makeOps();
    const providerAccounts = {
      ...makeRepositories().providerAccounts,
      getProviderAccount: vi.fn(async () => null),
    };
    const repositories = makeRepositories({ providerAccounts });
    const service = new SettingsDesiredStateService({ ops, repositories });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    const firstProviderAccountSave =
      providerAccounts.saveProviderAccount.mock.invocationCallOrder[0];
    const firstRouteSave = ops.setConversationRoute.mock.invocationCallOrder[0];
    expect(firstProviderAccountSave).toBeLessThan(firstRouteSave);
    expect(providerAccounts.saveProviderAccount).toHaveBeenCalledTimes(2);
    expect(ops.setConversationRoute).toHaveBeenCalledTimes(2);
  });

  it('persists conversation installs under their provider account', async () => {
    const settings = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  main_agent:
    name: Main
provider_accounts:
  slack_one:
    agent: main_agent
    provider: slack
    label: Slack One
  slack_two:
    agent: main_agent
    provider: slack
    label: Slack Two
conversations:
  sales:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: Sales
    control_approvers: ["UADMIN"]
    installed_agents:
      main_agent:
        provider_account: slack_two
        trigger: "@main"
`);
    const ops = makeOps();
    const repositories = makeRepositories({
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        getProviderAccount: vi.fn(async (id: string) => ({
          id,
          appId: 'default',
          agentId: 'agent:main_agent',
          providerId: 'slack',
          label: id,
          status: 'active',
          config: {},
          runtimeSecretRefs: {},
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        })),
      },
      conversations: {
        getConversation: vi.fn(async () => null),
        getConversationByExternalRef: vi.fn(async () => null),
        saveConversation: vi.fn(async () => undefined),
        replaceConversationApprovers: vi.fn(async () => []),
        listParticipantExternalUserIds: vi.fn(async (conversationId: string) =>
          conversationId === 'conversation:slack_one:sl:slack:C123'
            ? ['UADMIN']
            : [],
        ),
      },
    });
    const service = new SettingsDesiredStateService({ ops, repositories });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    expect(
      repositories.providerAccounts.saveConversationInstall,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: 'slack_two',
        conversationId: 'conversation:slack_two:sl:slack:C123',
      }),
    );
    expect(repositories.conversations.saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation:slack_two:sl:slack:C123',
        providerAccountId: 'slack_two',
      }),
    );
    expect(
      repositories.conversations.replaceConversationApprovers,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation:slack_two:sl:slack:C123',
        externalUserIds: ['UADMIN'],
      }),
    );
    expect(
      repositories.conversations.replaceConversationApprovers,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation:slack_one:sl:slack:C123',
        externalUserIds: ['UADMIN'],
      }),
    );
  });

  it('preserves provider account from keyed conversation installs', async () => {
    const settings = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  main_agent:
    name: Main
provider_accounts:
  slack_one:
    agent: main_agent
    provider: slack
    label: Slack One
  slack_two:
    agent: main_agent
    provider: slack
    label: Slack Two
conversations:
  sales:
    provider_account: slack_one
    id: slack:C123
    type: channel
    display_name: Sales
    installed_agents:
      sales_bot:
        agent: main_agent
        provider_account: slack_two
        trigger: "@sales"
`);
    const ops = makeOps();
    const repositories = makeRepositories({
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        getProviderAccount: vi.fn(async (id: string) => ({
          id,
          appId: 'default',
          agentId: 'agent:main_agent',
          providerId: 'slack',
          label: id,
          status: 'active',
          config: {},
          runtimeSecretRefs: {},
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        })),
      },
      conversations: {
        getConversation: vi.fn(async () => null),
        getConversationByExternalRef: vi.fn(async () => null),
        saveConversation: vi.fn(async () => undefined),
        replaceConversationApprovers: vi.fn(async () => []),
      },
    });
    const service = new SettingsDesiredStateService({ ops, repositories });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    expect(ops.setConversationRoute).toHaveBeenCalledWith(
      makeAgentThreadQueueKey(
        'sl:slack:C123',
        'agent:main_agent',
        undefined,
        'slack_two',
      ),
      expect.objectContaining({ providerAccountId: 'slack_two' }),
    );
    expect(
      repositories.providerAccounts.saveConversationInstall,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: 'slack_two',
        conversationId: 'conversation:slack_two:sl:slack:C123',
      }),
    );
  });

  it('preserves installed agent thread ids in routes and conversation installs', async () => {
    const settings = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  main_agent:
    name: Main
provider_accounts:
  slack_default:
    agent: main_agent
    provider: slack
    label: Slack
conversations:
  sales:
    provider_account: slack_default
    id: slack:C123
    type: channel
    display_name: Sales
    installed_agents:
      main_agent:
        provider_account: slack_default
        thread_id: "171.222"
        trigger: "@main"
`);
    const ops = makeOps();
    const repositories = makeRepositories({
      conversations: {
        getConversation: vi.fn(async () => null),
        getConversationByExternalRef: vi.fn(async () => null),
        saveConversation: vi.fn(async () => undefined),
        saveThread: vi.fn(async () => undefined),
        replaceConversationApprovers: vi.fn(async () => []),
      },
    });
    const service = new SettingsDesiredStateService({ ops, repositories });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    expect(ops.setConversationRoute).toHaveBeenCalledWith(
      makeAgentThreadQueueKey(
        'sl:slack:C123',
        'agent:main_agent',
        '171.222',
        'slack_default',
      ),
      expect.objectContaining({ providerAccountId: 'slack_default' }),
    );
    expect(
      repositories.providerAccounts.saveConversationInstall,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread:slack_default:sl:slack:C123:171.222',
      }),
    );
    expect(repositories.conversations.saveThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'thread:slack_default:sl:slack:C123:171.222',
        conversationId: 'conversation:slack_default:sl:slack:C123',
        externalRef: { kind: 'conversation_thread', value: '171.222' },
      }),
    );
  });

  it('does not route disabled conversation installs from settings', async () => {
    const settings = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  main_agent:
    name: Main
provider_accounts:
  slack_default:
    agent: main_agent
    provider: slack
    label: Slack
conversations:
  sales:
    provider_account: slack_default
    id: slack:C123
    type: channel
    display_name: Sales
    installed_agents:
      main_agent:
        provider_account: slack_default
        status: disabled
        trigger: "@main"
`);
    const ops = makeOps();
    const repositories = makeRepositories({
      conversations: {
        getConversation: vi.fn(async () => null),
        getConversationByExternalRef: vi.fn(async () => null),
        saveConversation: vi.fn(async () => undefined),
        replaceConversationApprovers: vi.fn(async () => []),
      },
    });
    const service = new SettingsDesiredStateService({ ops, repositories });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    expect(ops.setConversationRoute).not.toHaveBeenCalled();
    expect(
      repositories.providerAccounts.saveConversationInstall,
    ).not.toHaveBeenCalled();
    expect(
      repositories.providerAccounts.disableConversationInstall,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:main_agent',
        conversationId: 'conversation:slack_default:sl:slack:C123',
      }),
    );
  });

  it('disables active conversation installs removed from authoritative settings', async () => {
    const settings = parseRuntimeSettings(`desired_state:
  authoritative: true
providers:
  slack:
    enabled: true
agents:
  main_agent:
    name: Main
provider_accounts:
  slack_default:
    agent: main_agent
    provider: slack
    label: Slack
conversations:
  sales:
    provider_account: slack_default
    id: slack:C123
    type: channel
    display_name: Sales
`);
    const repositories = makeRepositories({
      conversations: {
        getConversation: vi.fn(async () => null),
        getConversationByExternalRef: vi.fn(async () => null),
        saveConversation: vi.fn(async () => undefined),
        replaceConversationApprovers: vi.fn(async () => []),
      },
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        listConversationInstallsByConversation: vi.fn(async () => [
          {
            id: 'agent-conversation-binding:main_agent:sales_main',
            appId: 'default',
            agentId: 'agent:main_agent',
            providerAccountId: 'slack_default',
            conversationId: 'conversation:slack_default:sl:slack:C123',
            displayName: 'Main',
            status: 'active',
            senderPolicy: 'provider_native',
            controlPolicy: 'conversation_approvers',
            memoryScope: 'conversation',
            memorySubject: {
              kind: 'conversation',
              appId: 'default',
              conversationId: 'conversation:slack_default:sl:slack:C123',
            },
            permissionPolicyIds: [],
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    await service.reconcile(settings);

    expect(
      repositories.providerAccounts.disableConversationInstall,
    ).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent:main_agent',
      conversationId: 'conversation:slack_default:sl:slack:C123',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
  });

  it('disables conversation installs against the install provider account conversation', async () => {
    const settings = parseRuntimeSettings(`providers:
  slack:
    enabled: true
agents:
  main_agent:
    name: Main
  side_agent:
    name: Side
provider_accounts:
  slack_default:
    agent: main_agent
    provider: slack
    label: Main Slack
  slack_side:
    agent: side_agent
    provider: slack
    label: Side Slack
conversations:
  sales:
    provider_account: slack_default
    id: slack:C123
    type: channel
    display_name: Sales
    installed_agents:
      side_agent:
        provider_account: slack_side
        status: disabled
        trigger: "@side"
`);
    const repositories = makeRepositories({
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        getProviderAccount: vi.fn(async (id: string) => ({
          id,
          appId: 'default',
          agentId:
            id === 'slack_side' ? 'agent:side_agent' : 'agent:main_agent',
          providerId: 'slack',
          label: id,
          status: 'active',
          config: {},
          runtimeSecretRefs: {},
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        })),
      },
      conversations: {
        getConversation: vi.fn(async () => null),
        getConversationByExternalRef: vi.fn(async () => null),
        saveConversation: vi.fn(async () => undefined),
        replaceConversationApprovers: vi.fn(async () => []),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.providerAccounts.disableConversationInstall,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:side_agent',
        conversationId: 'conversation:slack_side:sl:slack:C123',
      }),
    );
  });

  it('persists provider accounts before conversations are selected', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack['default' + 'Connection'] = 'slack_default';
    settings.providerAccounts.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    const existingProviderAccount = {
      id: 'slack_default',
      appId: 'default',
      agentId: 'agent:main_agent',
      providerId: 'slack',
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'workspace:T123',
      },
      label: 'Old Slack Label',
      status: 'active',
      config: { workspaceId: 'T123' },
      runtimeSecretRefs: { bot_token: 'env:OLD_SLACK_BOT_TOKEN' },
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    const repositories = makeRepositories({
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        getProviderAccount: vi.fn(async () => existingProviderAccount),
        saveProviderAccount: vi.fn(async () => undefined),
        saveConversationInstall: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    const result = await service.reconcile(settings);

    expect(result.applied).toContain('provider_account:slack_default');
    expect(
      repositories.providerAccounts.saveProviderAccount,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'slack_default',
        providerId: 'slack',
        externalIdentityRef: {
          kind: 'provider_account',
          value: 'workspace:T123',
        },
        label: 'Slack Default',
        config: { workspaceId: 'T123' },
        runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
        createdAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    expect(
      repositories.providerAccounts.saveConversationInstall,
    ).not.toHaveBeenCalled();
  });

  it('persists fresh desired-state agents before their provider accounts', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providerAccounts.slack_default = {
      agentId: 'main_agent',
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
    const repositories = makeRepositories({
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        getProviderAccount: vi.fn(async () => null),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    await service.reconcile(settings);

    expect(repositories.agents.saveAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent:main_agent' }),
    );
    expect(
      repositories.providerAccounts.saveProviderAccount,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'slack_default',
        agentId: 'agent:main_agent',
      }),
    );
    expect(
      repositories.agents.saveAgent.mock.invocationCallOrder[0],
    ).toBeLessThan(
      repositories.providerAccounts.saveProviderAccount.mock
        .invocationCallOrder[0],
    );
  });

  it('disables configured provider accounts when their provider is disabled', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = false;
    settings.providers.slack['default' + 'Connection'] = 'slack_default';
    settings.providerAccounts.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    await service.reconcile(settings);

    expect(
      repositories.providerAccounts.saveProviderAccount,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'slack_default',
        providerId: 'slack',
        status: 'disabled',
      }),
    );
  });

  it('disables active provider accounts removed from desired settings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    const repositories = makeRepositories({
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        listProviderAccounts: vi.fn(async () => [
          {
            id: 'slack_default',
            appId: 'default',
            agentId: 'agent:side_agent',
            providerId: 'slack',
            label: 'Slack Default',
            status: 'active',
            config: {},
            runtimeSecretRefs: {},
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
          {
            id: 'app_default',
            appId: 'default',
            providerId: 'app',
            label: 'App',
            status: 'active',
            config: {},
            runtimeSecretRefs: {},
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
        disableProviderAccount: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    const result = await service.reconcile(settings);

    expect(result.applied).toContain(
      'provider_account:slack_default:disabled_absent',
    );
    expect(
      repositories.providerAccounts.disableProviderAccount,
    ).toHaveBeenCalledOnce();
    expect(
      repositories.providerAccounts.disableProviderAccount,
    ).toHaveBeenCalledWith({
      appId: 'default',
      id: 'slack_default',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
  });

  it('keeps active provider accounts omitted from non-authoritative settings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = false;
    const repositories = makeRepositories({
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        listProviderAccounts: vi.fn(async () => [
          {
            id: 'slack_default',
            appId: 'default',
            agentId: 'agent:side_agent',
            providerId: 'slack',
            label: 'Slack Default',
            status: 'active',
            config: {},
            runtimeSecretRefs: {},
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
        disableProviderAccount: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    const result = await service.reconcile(settings);

    expect(result.applied).not.toContain(
      'provider_account:slack_default:disabled_absent',
    );
    expect(
      repositories.providerAccounts.disableProviderAccount,
    ).not.toHaveBeenCalled();
  });

  it('rejects changing the provider behind an existing connection id', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram['default' + 'Connection'] =
      'default_connection';
    settings.providerAccounts.default_connection = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    const repositories = makeRepositories({
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        getProviderAccount: vi.fn(async () => ({
          id: 'default_connection',
          appId: 'default',
          providerId: 'slack',
          externalIdentityRef: {
            kind: 'provider_account',
            value: 'workspace:T123',
          },
          label: 'Slack',
          status: 'active',
          config: { workspaceId: 'T123' },
          runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        })),
        saveProviderAccount: vi.fn(async () => undefined),
        saveConversationInstall: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    await expect(service.reconcile(settings)).rejects.toThrow(
      'provider_accounts.default_connection.provider cannot change from slack to telegram',
    );
    expect(
      repositories.providerAccounts.saveProviderAccount,
    ).not.toHaveBeenCalled();
  });

  it('persists top-level bindings per agent without id collisions', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack['default' + 'Connection'] = 'slack_default';
    settings.providerAccounts.slack_default = {
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
      ['requires' + 'Trigger']: true,
      memoryScope: 'agent',
    };
    settings.bindings.sales_ops = {
      agent: 'ops_agent',
      conversation: 'sales',
      trigger: '@ops',
      addedAt: '2026-05-02T00:00:00.000Z',
      ['requires' + 'Trigger']: true,
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
      repositories.providerAccounts.saveConversationInstall.mock.calls.map(
        ([install]: any[]) => install,
      );
    expect(savedBindings.map((install: any) => install.id).sort()).toEqual([
      'agent-conversation-binding:main_agent:sales_main',
      'agent-conversation-binding:ops_agent:sales_ops',
    ]);
    expect(savedBindings).toContainEqual(
      expect.objectContaining({
        id: 'agent-conversation-binding:main_agent:sales_main',
        agentId: 'agent:main_agent',
        memoryScope: 'agent',
        memorySubject: expect.objectContaining({
          kind: 'agent',
          appId: 'default',
          agentId: 'agent:main_agent',
          route: expect.objectContaining({
            configuredConversationId: 'sales',
            trigger: '@main',
            requiresTrigger: true,
          }),
        }),
      }),
    );
  });

  it('persists user memory subjects for desired-state DM bindings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack['default' + 'Connection'] = 'slack_default';
    settings.providerAccounts.slack_default = {
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
      ['requires' + 'Trigger']: true,
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
      repositories.providerAccounts.saveConversationInstall,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryScope: 'user',
        memorySubject: expect.objectContaining({
          kind: 'user',
          appId: 'default',
          userId: 'U123',
          route: expect.objectContaining({
            trigger: '@main',
            requiresTrigger: true,
          }),
        }),
      }),
    );
  });

  it('does not report drift for matching canonical top-level bindings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram['default' + 'Connection'] = 'telegram_default';
    settings.providerAccounts.telegram_default = {
      agentId: 'main_agent',
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
      providerAccount: 'telegram_default',
      externalId: '-100123',
      kind: 'group',
      displayName: 'Main',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {},
    };
    settings.bindings.main = {
      agent: 'main_agent',
      conversation: 'main',
      trigger: '@main',
      addedAt: '2026-05-02T00:00:00.000Z',
      ['requires' + 'Trigger']: true,
      memoryScope: 'conversation',
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        [makeAgentThreadQueueKey(
          'tg:-100123',
          'agent:main_agent',
          undefined,
          'telegram_default',
        )]: {
          name: 'Main',
          folder: 'main_agent',
          trigger: '@main',
          added_at: '2026-05-02T00:00:00.000Z',
          providerAccountId: 'telegram_default',
        },
      }),
      repositories: makeRepositories(),
    });

    await expect(service.drift(settings)).resolves.toMatchObject({
      dbOnlyGroupJids: [],
      missingSettingsAgents: [],
    });
  });

  it('reports persisted unregistered group metadata in settings drift', async () => {
    const settings = createDefaultRuntimeSettings();
    const service = new SettingsDesiredStateService({
      ops: makeOps({}, [
        { jid: 'tg:-1001234', is_group: 1 },
        { jid: 'tg:222', is_group: 0 },
      ]),
      repositories: makeRepositories(),
    });

    await expect(service.drift(settings)).resolves.toMatchObject({
      dbOnlyGroupJids: ['tg:-1001234'],
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

  it('removes stale bare routes for configured agent bindings in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        primary: {
          jid: 'tg:100',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          ['requires' + 'Trigger']: true,
        },
      },
      sources: emptySources(),
      capabilities: [],
    };
    const ops = makeOps({
      'tg:100': {
        name: 'Main',
        folder: 'main_agent',
        trigger: '@main',
        added_at: '2026-05-02T00:00:00.000Z',
      },
    });
    const service = new SettingsDesiredStateService({
      ops,
      repositories: makeRepositories(),
    });

    await service.reconcile(settings);

    expect(ops.setConversationRoute).toHaveBeenCalledWith(
      makeAgentThreadQueueKey('tg:100', 'agent:main_agent'),
      expect.objectContaining({ folder: 'main_agent' }),
    );
    expect(ops.deleteConversationRoute).toHaveBeenCalledWith('tg:100');
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
        id: 'agent-skill-install:agent:main_agent:skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
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
        id: 'agent-skill-install:agent:main_agent:skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
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
    settings.providers.telegram['default' + 'Connection'] = 'telegram_default';
    settings.providerAccounts.telegram_default = {
      agentId: 'main_agent',
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
      agentId: 'agent:main_agent',
      providerId: 'telegram',
      label: 'Telegram Default',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
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
      providerAccounts: {
        getProviderAccount: vi.fn(async (id: string) =>
          id === 'telegram_default' ? providerConnection : null,
        ),
        saveProviderAccount: vi.fn(async () => undefined),
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
      repositories.providerAccounts.saveProviderAccount,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'telegram_default',
        providerId: 'telegram',
        runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
      }),
    );
    expect(conversations.saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation:telegram_default:tg:-100123',
        providerAccountId: 'telegram_default',
        externalRef: { kind: 'conversation', value: '-100123' },
        kind: 'group',
      }),
    );
    expect(conversations.replaceConversationApprovers).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation:telegram_default:tg:-100123',
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
    ).resolves.toBe(false);
  });

  it('reconciles one agent with conversation approvers', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack['default' + 'Connection'] = 'slack_default';
    settings.providers.teams.enabled = true;
    settings.providers.teams['default' + 'Connection'] = 'teams_default';
    settings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    settings.providerAccounts.teams_default = {
      agentId: 'main_agent',
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
          ['requires' + 'Trigger']: true,
        },
        teams_sales: {
          jid: 'teams:19:channel@thread.tacv2',
          name: 'Sales Teams',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          ['requires' + 'Trigger']: true,
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
      providerAccounts: {
        getProviderAccount: vi.fn(async (id: string) => ({
          id,
          appId: 'default',
          agentId: 'agent:main_agent',
          providerId: id === 'slack_default' ? 'slack' : 'teams',
          label: id,
          status: 'active',
          config: {},
          runtimeSecretRefs: {},
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        })),
        saveProviderAccount: vi.fn(async () => undefined),
        saveConversationInstall: vi.fn(async () => undefined),
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
        ['conversation:slack_default:sl:C123', ['U123']],
        [
          'conversation:teams_default:teams:19:channel@thread.tacv2',
          ['8:orgid:abc'],
        ],
      ]),
    );
  });

  it('does not rewrite another provider conversation when external IDs collide', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram['default' + 'Connection'] = 'telegram_default';
    settings.providers.slack.enabled = true;
    settings.providers.slack['default' + 'Connection'] = 'slack_default';
    settings.providerAccounts.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.providerAccounts.slack_default = {
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
      providerAccountId: 'slack_default',
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
        id: 'conversation:sl:C123',
        providerAccountId: 'telegram_default',
        title: 'Telegram C123',
      }),
    );
  });

  it('skips settings approvers that are not known conversation members', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack['default' + 'Connection'] = 'slack_default';
    settings.providerAccounts.slack_default = {
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

  it('exports colliding bindings without overwriting one another', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      agentHarness: 'deepagents',
      bindings: {},
      sources: emptySources(),
      capabilities: [],
      accessPreset: 'full',
    };
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
    const installJids = Object.values(exported.agents.main_agent.bindings).map(
      (install) => install.jid,
    );

    expect(installJids.sort()).toEqual(['tg abc', 'tg/abc']);
    expect(Object.keys(exported.agents.main_agent.bindings)).toHaveLength(2);
    expect(exported.agents.main_agent.agentHarness).toBe('deepagents');
  });

  it('exports desired state with batched agent and conversation reads', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack = {
      enabled: true,
      ['default' + 'Connection']: 'slack_default',
    };
    settings.providerAccounts.slack_default = {
      provider: 'slack',
      label: 'Slack',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    const storedConversation = {
      id: 'conversation:sl:C100',
      appId: 'default',
      providerAccountId: 'slack_default',
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
          ['requires' + 'Trigger']: false,
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
      ['default' + 'Connection']: 'telegram_default',
    };
    settings.providerAccounts.telegram_default = {
      provider: 'telegram',
      label: 'Telegram',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    const slackConversation = {
      id: 'conversation:sl:-100123',
      appId: 'default',
      providerAccountId: 'slack_default',
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
          ['requires' + 'Trigger']: false,
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
      ['default' + 'Connection']: 'telegram_default',
    };
    settings.providerAccounts.telegram_default = {
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
      ['requires' + 'Trigger']: false,
      memoryScope: 'conversation',
    };
    settings.bindings.main_telegram_group = {
      agent: 'main_agent',
      conversation: 'main_telegram_group',
      trigger: '@Default Agent',
      addedAt: '2026-05-01T00:00:00.000Z',
      ['requires' + 'Trigger']: false,
      memoryScope: 'conversation',
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        'tg:-100123': {
          name: 'Default Agent Telegram Group',
          folder: 'main_agent',
          trigger: '@Default Agent',
          added_at: '2026-05-01T00:00:00.000Z',
          ['requires' + 'Trigger']: false,
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
      agentHarness: 'deepagents',
      bindings: {},
      sources: {
        skills: [{ id: 'stale-skill' }],
        mcpServers: [],
        tools: [],
      },
      capabilities: [{ id: 'stale-tool', version: 'builtin' }],
    };
    settings.providerAccounts.slack_default = {
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
      ['requires' + 'Trigger']: true,
      memoryScope: 'conversation',
      model: 'haiku',
    };
    settings.bindings.stale = {
      agent: 'side_agent',
      conversation: 'missing',
      trigger: '@stale',
      addedAt: '2026-05-01T00:00:00.000Z',
      ['requires' + 'Trigger']: true,
      memoryScope: 'conversation',
    };
    const storedConversation = {
      id: 'conversation:sl:C123',
      appId: 'default',
      providerAccountId: 'slack_default',
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
      providerAccounts: {
        ...makeRepositories().providerAccounts,
        listProviderAccounts: vi.fn(async () => [
          {
            id: 'slack_default',
            appId: 'default',
            agentId: 'agent:side_agent',
            providerId: 'slack',
            label: 'Slack Workspace',
            status: 'active',
            config: {},
            runtimeSecretRefs: {
              bot_token: 'env:SLACK_BOT_TOKEN',
              app_token: 'env:SLACK_APP_TOKEN',
            },
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
        listConversationInstalls: vi.fn(async () => [
          {
            id: 'install:side_sales',
            appId: 'default',
            agentId: 'agent:side_agent',
            providerAccountId: 'slack_default',
            conversationId: storedConversation.id,
            displayName: 'Sales Channel',
            status: 'active',
            triggerMode: 'keyword',
            ['trigger' + 'Pattern']: '@side',
            ['requires' + 'Trigger']: true,
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
            id: 'agent-tool-install:side-read',
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
            id: 'agent-skill-install:side-custom',
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
            id: 'agent-mcp-install:side-github',
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
        agentHarness: 'deepagents',
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
    expect(exported.providerAccounts.slack_default).toEqual({
      agentId: 'side_agent',
      provider: 'slack',
      label: 'Slack Workspace',
      status: 'active',
      runtimeSecretRefs: {
        bot_token: 'env:SLACK_BOT_TOKEN',
        app_token: 'env:SLACK_APP_TOKEN',
      },
      externalIdentityRef: undefined,
      config: {},
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
        trigger: '@old',
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
            id: 'agent-tool-install:generated-skill-command',
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
            id: 'agent-skill-install:linkedin',
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
            id: 'agent-tool-install:generated-skill-command',
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

  it('classifies observability tracing changes as restart-required', () => {
    const before = createDefaultRuntimeSettings();
    const after = createDefaultRuntimeSettings();
    after.observability.tracing.enabled = true;
    after.observability.tracing.endpoint = 'https://otlp.example.test/traces';

    expect(classifySettingsChanges(before, after)).toEqual({
      liveApplied: [],
      restartRequired: ['observability'],
    });
  });
});

describe('reconcile preserves agent-installed bindings', () => {
  function agentInstalledSkill() {
    return {
      id: 'skill:agentic',
      appId: 'default',
      name: 'agentic-notes',
      source: 'agent_created',
      status: 'installed',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      storage: { type: 'local' },
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    };
  }

  function agentSkillBinding(status: 'active' | 'disabled') {
    return {
      id: 'agent-skill-binding:agent:main_agent:skill:agentic',
      appId: 'default',
      agentId: 'agent:main_agent',
      skillId: 'skill:agentic',
      status,
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    };
  }

  function agentRequestedMcpServer() {
    return {
      id: 'mcp:crm',
      appId: 'default',
      status: 'active',
      name: 'crm',
      createdSource: 'agent_request',
      riskClass: 'medium',
      transport: 'stdio_template',
      config: { transport: 'stdio_template', templateId: 'crm' },
      allowedToolPatterns: [],
      autoApproveToolPatterns: [],
      credentialRefs: [],
    };
  }

  function agentMcpBinding(status: 'active' | 'disabled') {
    return {
      id: 'agent-mcp-binding:agent:main_agent:mcp:crm',
      appId: 'default',
      agentId: 'agent:main_agent',
      serverId: 'mcp:crm',
      status,
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: [],
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    };
  }

  function repositoriesWithAgentInstalls(input: {
    skillBindingStatus?: 'active' | 'disabled';
    mcpBindingStatus?: 'active' | 'disabled';
    mcpServer?: Record<string, unknown>;
  }) {
    const base = makeRepositories();
    return makeRepositories({
      skills: {
        ...base.skills,
        getSkill: vi.fn(async (id: string) =>
          id === 'skill:agentic'
            ? agentInstalledSkill()
            : base.skills.getSkill(id),
        ),
        listAgentSkillBindings: vi.fn(async () => [
          agentSkillBinding(input.skillBindingStatus ?? 'active'),
        ]),
      },
      mcpServers: {
        ...base.mcpServers,
        getServer: vi.fn(async (id: string) =>
          id === 'mcp:crm'
            ? (input.mcpServer ?? agentRequestedMcpServer())
            : base.mcpServers.getServer(id),
        ),
        listAgentBindings: vi.fn(async () => [
          agentMcpBinding(input.mcpBindingStatus ?? 'active'),
        ]),
      },
    });
  }

  it('unions agent-request-created active bindings into the replacement set', async () => {
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
      capabilities: [],
    };
    const repositories = repositoriesWithAgentInstalls({});
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    const call =
      repositories.agents.replaceAgentCapabilityBindings.mock.calls[0]?.[0];
    expect(call.skillBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skillId: 'skill:admin', status: 'active' }),
        expect.objectContaining({ skillId: 'skill:agentic', status: 'active' }),
      ]),
    );
    expect(call.mcpBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: 'mcp:github' }),
        expect.objectContaining({ serverId: 'mcp:crm', status: 'active' }),
      ]),
    );
  });

  it('removes active agent-request bindings explicitly disabled by an authoritative revision', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: {
        skills: [
          { id: 'skill:admin' },
          { id: 'skill:agentic', status: 'disabled' },
        ],
        mcpServers: [{ id: 'mcp:crm', status: 'disabled' }],
        tools: [],
      },
      capabilities: [],
    };
    const repositories = repositoriesWithAgentInstalls({});
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    const call =
      repositories.agents.replaceAgentCapabilityBindings.mock.calls[0]?.[0];
    expect(call.skillBindings).toEqual([
      expect.objectContaining({ skillId: 'skill:admin' }),
    ]);
    expect(call.mcpBindings).toEqual([]);
    expect(repositories.skills.getSkill).not.toHaveBeenCalledWith(
      'skill:agentic',
    );
    expect(repositories.mcpServers.getServer).not.toHaveBeenCalledWith(
      'mcp:crm',
    );
  });

  it('does not preserve admin-created bindings absent from settings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: { skills: [{ id: 'skill:admin' }], mcpServers: [], tools: [] },
      capabilities: [],
    };
    const repositories = repositoriesWithAgentInstalls({
      mcpServer: { ...agentRequestedMcpServer(), createdSource: 'admin' },
    });
    // The bound skill is admin-uploaded, not agent-created.
    const previousGetSkill = repositories.skills.getSkill;
    repositories.skills.getSkill = vi.fn(async (id: string) =>
      id === 'skill:agentic'
        ? { ...agentInstalledSkill(), source: 'admin_uploaded' }
        : previousGetSkill(id),
    );
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    const call =
      repositories.agents.replaceAgentCapabilityBindings.mock.calls[0]?.[0];
    expect(call.skillBindings).toEqual([
      expect.objectContaining({ skillId: 'skill:admin' }),
    ]);
    expect(call.mcpBindings).toEqual([]);
  });

  it('warns and skips inactive configured MCP servers instead of failing the reconcile', async () => {
    const { replaceDesiredStateCapabilities } =
      await import('@core/config/settings/desired-state-capability-reconcile.js');
    const repositories = makeRepositories();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await replaceDesiredStateCapabilities({
        appId: 'default' as never,
        agentId: 'agent:main_agent' as never,
        agent: {
          name: 'Main',
          folder: 'main_agent',
          bindings: {},
          sources: {
            skills: [],
            mcpServers: [{ id: 'mcp:github' }, { id: 'mcp:missing' }],
            tools: [],
          },
          capabilities: [],
        } as never,
        repositories,
        now: '2026-07-20T00:00:00.000Z',
        authoritative: true,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('mcp:missing is not active'),
      );
    } finally {
      warn.mockRestore();
    }
    const call =
      repositories.agents.replaceAgentCapabilityBindings.mock.calls[0]?.[0];
    expect(call.mcpBindings).toEqual([
      expect.objectContaining({ serverId: 'mcp:github' }),
    ]);
  });
});
