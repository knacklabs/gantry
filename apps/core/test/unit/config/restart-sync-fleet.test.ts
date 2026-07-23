import { afterEach, describe, expect, it, vi } from 'vitest';

class MockSettingsStaleMutationError extends Error {}
class MockSettingsRevisionConflictError extends Error {}

function mockProjectionSync(
  settings: Array<{
    runtime: { deploymentMode: string };
    revisionMarker?: string;
  }>,
) {
  const loadRuntimeSettings = vi.fn();
  for (const value of settings) loadRuntimeSettings.mockReturnValueOnce(value);
  const exportCurrent = vi.fn(async (value) => ({
    ...value,
    projectionMarker: value.revisionMarker,
  }));
  const importWorkstationSettings = vi.fn();
  vi.doMock('@core/config/settings/desired-state-service.js', () => ({
    SettingsDesiredStateService: class {
      exportCurrent(value) {
        return exportCurrent(value);
      }
    },
  }));
  vi.doMock('@core/config/settings/runtime-settings.js', () => ({
    loadRuntimeSettings,
    saveRuntimeSettings: vi.fn(),
    activateRuntimeModelAliases: vi.fn(),
    addAgentToolRulesToRuntimeSettings: vi.fn(),
    removeAgentToolRulesFromRuntimeSettings: vi.fn(),
    withRuntimeModelAliases: vi.fn((_settings, fn) => fn()),
  }));
  vi.doMock('@core/config/settings/settings-import-service.js', () => ({
    importWorkstationSettings,
    SettingsStaleMutationError: MockSettingsStaleMutationError,
    SettingsRevisionConflictError: MockSettingsRevisionConflictError,
  }));
  vi.doMock(
    '@core/config/settings/configured-capability-normalization.js',
    () => ({ normalizeConfiguredCapabilitiesInSettings: vi.fn() }),
  );
  vi.doMock('@core/config/settings/runtime-settings-validation.js', () => ({
    validateLoadedRuntimeSettings: vi.fn(),
  }));
  return {
    exportCurrent,
    importWorkstationSettings,
    loadRuntimeSettings,
  };
}

describe('syncRuntimeSettingsFromProjection fleet mode', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@core/config/settings/desired-state-service.js');
    vi.doUnmock('@core/config/settings/runtime-settings.js');
    vi.doUnmock('@core/config/settings/settings-import-service.js');
    vi.doUnmock('@core/config/settings/configured-capability-normalization.js');
    vi.doUnmock('@core/config/settings/runtime-settings-validation.js');
  });

  it('appends a fleet settings revision instead of applying local YAML', async () => {
    const exported = { runtime: { deploymentMode: 'fleet' } };
    const mocks = mockProjectionSync([exported]);
    mocks.exportCurrent.mockResolvedValue(exported);
    mocks.importWorkstationSettings.mockResolvedValue({ revision: 3 });

    const { syncRuntimeSettingsFromProjection } =
      await import('@core/config/settings/restart-sync.js');
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => null),
    } as never;
    await syncRuntimeSettingsFromProjection({
      runtimeHome: '/tmp/gantry-test',
      ops: {} as never,
      repositories: {} as never,
      appId: 'app:test' as never,
      settingsRevisions,
    });

    expect(mocks.importWorkstationSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        revisionMirror: expect.objectContaining({
          settingsRevisions,
          createdBy: 'projection-sync',
        }),
        revisionMirrorRequired: true,
      }),
      exported,
    );
  });

  it('applies an explicit provider secret clear to the exported settings revision', async () => {
    const settings = { runtime: { deploymentMode: 'fleet' } };
    const mocks = mockProjectionSync([settings]);
    mocks.exportCurrent.mockResolvedValue({
      runtime: { deploymentMode: 'fleet' },
      providerAccounts: {
        'slack-one': {
          runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
        },
      },
    });
    mocks.importWorkstationSettings.mockResolvedValue({ revision: 3 });

    const { syncRuntimeSettingsFromProjection } =
      await import('@core/config/settings/restart-sync.js');
    await syncRuntimeSettingsFromProjection({
      runtimeHome: '/tmp/gantry-test',
      ops: {} as never,
      repositories: {} as never,
      settingsRevisions: {} as never,
      overrides: {
        providerAccount: { id: 'slack-one', runtimeSecretRefs: {} },
      },
    });

    expect(mocks.importWorkstationSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        providerAccounts: {
          'slack-one': expect.objectContaining({ runtimeSecretRefs: {} }),
        },
      }),
    );
  });

  it('retries stale projection imports but not non-stale failures', async () => {
    const staleSettings = {
      runtime: { deploymentMode: 'fleet' },
      revisionMarker: 'stale',
    };
    const freshSettings = {
      runtime: { deploymentMode: 'fleet' },
      revisionMarker: 'fresh',
    };
    const mocks = mockProjectionSync([staleSettings, freshSettings]);
    mocks.importWorkstationSettings
      .mockRejectedValueOnce(new MockSettingsStaleMutationError())
      .mockResolvedValueOnce({ revision: 3 });

    const { syncRuntimeSettingsFromProjection } =
      await import('@core/config/settings/restart-sync.js');
    await syncRuntimeSettingsFromProjection({
      runtimeHome: '/tmp/gantry-test',
      ops: {} as never,
      repositories: {} as never,
      settingsRevisions: {} as never,
    });

    expect(mocks.loadRuntimeSettings).toHaveBeenCalledTimes(2);
    expect(mocks.exportCurrent).toHaveBeenNthCalledWith(1, staleSettings);
    expect(mocks.exportCurrent).toHaveBeenNthCalledWith(2, freshSettings);
    expect(mocks.importWorkstationSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ previousSettings: freshSettings }),
      expect.objectContaining({
        revisionMarker: 'fresh',
        projectionMarker: 'fresh',
      }),
    );

    const failure = new Error('write failed');
    mocks.loadRuntimeSettings.mockClear().mockReturnValueOnce(freshSettings);
    mocks.exportCurrent.mockClear();
    mocks.importWorkstationSettings.mockClear();
    mocks.importWorkstationSettings.mockImplementationOnce(async () => {
      throw failure;
    });
    await expect(
      syncRuntimeSettingsFromProjection({
        runtimeHome: '/tmp/gantry-test',
        ops: {} as never,
        repositories: {} as never,
        settingsRevisions: {} as never,
      }),
    ).rejects.toBe(failure);

    expect(mocks.loadRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(mocks.exportCurrent).toHaveBeenCalledTimes(1);
    expect(mocks.importWorkstationSettings).toHaveBeenCalledTimes(1);
  });

  it('retries conflicts while mirroring persistent tool-rule grants', async () => {
    const previousSettings = {
      runtime: { deploymentMode: 'fleet' },
      agents: {
        main: {
          sources: { mcpServers: [] },
          capabilities: [],
        },
        other: {
          sources: { mcpServers: [] },
          capabilities: [],
        },
      },
    };
    const importWorkstationSettings = vi
      .fn()
      .mockRejectedValueOnce(new MockSettingsRevisionConflictError())
      .mockResolvedValueOnce({ revision: 4 });
    const loadRuntimeSettings = vi.fn(() => previousSettings);
    const addAgentToolRulesToRuntimeSettings = vi.fn(
      (settings, agentFolder, rules) => {
        settings.agents[agentFolder].capabilities.push(...rules);
      },
    );
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings,
      saveRuntimeSettings: vi.fn(),
      activateRuntimeModelAliases: vi.fn(),
      addAgentToolRulesToRuntimeSettings,
      removeAgentToolRulesFromRuntimeSettings: vi.fn(),
      withRuntimeModelAliases: vi.fn((_settings, fn) => fn()),
    }));
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings,
      SettingsStaleMutationError: MockSettingsStaleMutationError,
      SettingsRevisionConflictError: MockSettingsRevisionConflictError,
    }));
    vi.doMock('@core/config/settings/desired-state-service.js', () => ({
      SettingsDesiredStateService: class {},
    }));
    vi.doMock(
      '@core/config/settings/configured-capability-normalization.js',
      () => ({
        normalizeConfiguredCapabilitiesInSettings: vi.fn(),
      }),
    );
    vi.doMock('@core/config/settings/runtime-settings-validation.js', () => ({
      validateLoadedRuntimeSettings: vi.fn(),
    }));

    const { addAgentToolRulesToSyncedRuntimeSettings } =
      await import('@core/config/settings/restart-sync.js');
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => null),
    } as never;
    const listAgentBindings = vi.fn(async () => []);
    await addAgentToolRulesToSyncedRuntimeSettings({
      runtimeHome: '/tmp/gantry-test',
      agentFolder: 'main',
      rules: ['Browser'],
      ops: {} as never,
      repositories: {
        mcpServers: { listAgentBindings },
      } as never,
      appId: 'app:test' as never,
      settingsRevisions,
    });

    expect(loadRuntimeSettings).toHaveBeenCalledTimes(2);
    expect(addAgentToolRulesToRuntimeSettings).toHaveBeenCalledTimes(2);
    expect(listAgentBindings).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:main',
    });
    expect(listAgentBindings).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:other',
    });
    expect(importWorkstationSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        previousSettings,
        revisionMirror: expect.objectContaining({
          settingsRevisions,
          createdBy: 'permission:persistent-tool-rule',
        }),
        revisionMirrorRequired: true,
      }),
      expect.objectContaining({
        runtime: { deploymentMode: 'fleet' },
        agents: expect.objectContaining({
          main: expect.objectContaining({
            capabilities: ['Browser'],
          }),
        }),
      }),
    );
  });

  it('fences every active MCP binding projected by a persistent grant', async () => {
    const previousSettings = {
      runtime: { deploymentMode: 'fleet' },
      agents: {
        main: {
          sources: { mcpServers: [] },
          capabilities: [],
        },
        empty: {
          sources: { mcpServers: [] },
          capabilities: [],
        },
      },
    };
    const importWorkstationSettings = vi.fn(async () => ({ revision: 4 }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(() => previousSettings),
      saveRuntimeSettings: vi.fn(),
      activateRuntimeModelAliases: vi.fn(),
      addAgentToolRulesToRuntimeSettings: vi.fn(
        (settings, agentFolder, rules) => {
          settings.agents[agentFolder].capabilities.push(
            ...rules.map((rule) => ({
              id: rule.replace(/^capability:/, ''),
              version: 'builtin',
            })),
          );
        },
      ),
      removeAgentToolRulesFromRuntimeSettings: vi.fn(),
      withRuntimeModelAliases: vi.fn((_settings, fn) => fn()),
    }));
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings,
      SettingsStaleMutationError: MockSettingsStaleMutationError,
      SettingsRevisionConflictError: MockSettingsRevisionConflictError,
    }));
    vi.doMock('@core/config/settings/desired-state-service.js', () => ({
      SettingsDesiredStateService: class {},
    }));
    vi.doMock(
      '@core/config/settings/configured-capability-normalization.js',
      () => ({ normalizeConfiguredCapabilitiesInSettings: vi.fn() }),
    );
    vi.doMock('@core/config/settings/runtime-settings-validation.js', () => ({
      validateLoadedRuntimeSettings: vi.fn(),
    }));

    const { addAgentToolRulesToSyncedRuntimeSettings } =
      await import('@core/config/settings/restart-sync.js');
    const reviewed = mcpBinding('mcp:reviewed', {
      allowedToolPatterns: ['get-sum'],
    });
    const unrelated = mcpBinding('mcp:unrelated', {
      required: true,
      permissionPolicyIds: ['policy:z', 'policy:a'],
      allowedToolPatterns: ['write_*', 'read_*'],
      conversationId: 'conversation:reviewed',
      threadId: 'thread:reviewed',
    });
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => null),
    } as never;
    const listAgentBindings = vi.fn(async ({ agentId }) =>
      agentId === 'agent:main' ? [reviewed, unrelated] : [],
    );

    await addAgentToolRulesToSyncedRuntimeSettings({
      runtimeHome: '/tmp/gantry-test',
      agentFolder: 'main',
      rules: ['capability:mcp.reviewed.read'],
      ops: {} as never,
      repositories: {
        mcpServers: {
          listAgentBindings,
        },
      } as never,
      appId: 'app:test' as never,
      settingsRevisions,
      expectedMcpBindings: [reviewed as never],
      mcpCapabilityGrantToken: 'permission-request:reviewed',
    });

    expect(listAgentBindings).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:main',
    });
    expect(importWorkstationSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedMcpBindingAgentIds: ['agent:empty', 'agent:main'],
        expectedMcpBindings: [
          expect.objectContaining({
            id: reviewed.id,
            allowedToolPatterns: ['get-sum'],
          }),
          expect.objectContaining({
            id: unrelated.id,
            required: true,
            permissionPolicyIds: ['policy:a', 'policy:z'],
            allowedToolPatterns: ['read_*', 'write_*'],
            conversationId: 'conversation:reviewed',
            threadId: 'thread:reviewed',
          }),
        ],
        mcpCapabilityGrantTokens: {
          '["main","mcp.reviewed.read","builtin"]':
            'permission-request:reviewed',
        },
      }),
      expect.objectContaining({
        agents: expect.objectContaining({
          main: expect.objectContaining({
            sources: {
              mcpServers: [
                { id: 'mcp:reviewed', tools: ['get-sum'] },
                {
                  id: 'mcp:unrelated',
                  tools: ['write_*', 'read_*'],
                },
              ],
            },
          }),
        }),
      }),
    );
  });

  it('bases grants on the latest revision without overwriting its pending MCP narrowing', async () => {
    const fileSettings = {
      runtime: { deploymentMode: 'workstation' },
      agents: {
        main: {
          sources: { mcpServers: [] },
          capabilities: ['old-file-rule'],
        },
      },
    };
    const latestSettings = {
      runtime: { deploymentMode: 'workstation' },
      agents: {
        main: {
          sources: {
            mcpServers: [{ id: 'mcp:sum', tools: ['get-sum'] }],
          },
          capabilities: ['latest-rule'],
        },
      },
    };
    const importWorkstationSettings = vi.fn(async () => ({ revision: 12 }));
    const settingsFromRevisionDocument = vi.fn(() => latestSettings);
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(() => fileSettings),
      saveRuntimeSettings: vi.fn(),
      activateRuntimeModelAliases: vi.fn(),
      addAgentToolRulesToRuntimeSettings: vi.fn(
        (settings, agentFolder, rules) => {
          settings.agents[agentFolder].capabilities.push(...rules);
        },
      ),
      removeAgentToolRulesFromRuntimeSettings: vi.fn(),
      withRuntimeModelAliases: vi.fn((_settings, fn) => fn()),
    }));
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      SettingsRevisionConflictError: MockSettingsRevisionConflictError,
      SettingsStaleMutationError: MockSettingsStaleMutationError,
      importWorkstationSettings,
      settingsFromRevisionDocument,
    }));
    vi.doMock('@core/config/settings/desired-state-service.js', () => ({
      SettingsDesiredStateService: class {},
    }));
    vi.doMock(
      '@core/config/settings/configured-capability-normalization.js',
      () => ({
        normalizeConfiguredCapabilitiesInSettings: vi.fn(),
      }),
    );
    vi.doMock('@core/config/settings/runtime-settings-validation.js', () => ({
      validateLoadedRuntimeSettings: vi.fn(),
    }));

    const { addAgentToolRulesToSyncedRuntimeSettings } =
      await import('@core/config/settings/restart-sync.js');
    const liveBinding = mcpBinding('mcp:sum', {
      allowedToolPatterns: ['echo', 'get-sum'],
    });
    const removedAgentBinding = mcpBinding('mcp:removed', {
      id: 'agent-mcp-binding:agent:removed:mcp:removed',
      agentId: 'agent:removed',
      allowedToolPatterns: ['read_*'],
    });
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => ({
        revision: 11,
        settingsDocument: { latest: true },
        mcpBindingPreconditionAgentIds: ['agent:main', 'agent:removed'],
        mcpBindingPreconditions: [liveBinding, removedAgentBinding],
      })),
    } as never;
    const listAgentBindings = vi.fn(async ({ agentId }) =>
      agentId === 'agent:main'
        ? [liveBinding]
        : agentId === 'agent:removed'
          ? [removedAgentBinding]
          : [],
    );
    await addAgentToolRulesToSyncedRuntimeSettings({
      runtimeHome: '/tmp/gantry-test',
      agentFolder: 'main',
      rules: ['mcp__gantry__admin_permission_list'],
      ops: {} as never,
      repositories: {
        mcpServers: { listAgentBindings },
      } as never,
      appId: 'app:test' as never,
      settingsRevisions,
    });

    expect(settingsFromRevisionDocument).toHaveBeenCalledWith({
      latest: true,
    });
    expect(importWorkstationSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        previousSettings: latestSettings,
        expectedRevision: 11,
        revisionMirrorRequired: true,
        expectedMcpBindingAgentIds: ['agent:main', 'agent:removed'],
        expectedMcpBindings: [
          expect.objectContaining({
            id: liveBinding.id,
            agentId: 'agent:main',
            allowedToolPatterns: ['echo', 'get-sum'],
          }),
          expect.objectContaining({
            id: removedAgentBinding.id,
            agentId: 'agent:removed',
            allowedToolPatterns: ['read_*'],
          }),
        ],
      }),
      expect.objectContaining({
        agents: expect.objectContaining({
          main: expect.objectContaining({
            capabilities: ['latest-rule', 'mcp__gantry__admin_permission_list'],
            sources: {
              mcpServers: [
                expect.objectContaining({
                  id: 'mcp:sum',
                  tools: ['get-sum'],
                }),
              ],
            },
          }),
        }),
      }),
    );
    expect(listAgentBindings).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:removed',
    });
  });

  it('fences MCP bindings while mirroring a persistent permission revoke', async () => {
    const previousSettings = {
      runtime: { deploymentMode: 'workstation' },
      agents: {
        main: {
          sources: {
            mcpServers: [{ id: 'mcp:sum', tools: ['get-sum'] }],
          },
          capabilities: ['capability:mcp.sum.read'],
        },
        empty: {
          sources: { mcpServers: [] },
          capabilities: [],
        },
      },
    };
    const importWorkstationSettings = vi.fn(async () => ({ revision: 12 }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(() => previousSettings),
      saveRuntimeSettings: vi.fn(),
      activateRuntimeModelAliases: vi.fn(),
      addAgentToolRulesToRuntimeSettings: vi.fn(),
      removeAgentToolRulesFromRuntimeSettings: vi.fn(
        (settings, agentFolder, rules) => {
          settings.agents[agentFolder].capabilities = settings.agents[
            agentFolder
          ].capabilities.filter((rule) => !rules.includes(rule));
        },
      ),
      withRuntimeModelAliases: vi.fn((_settings, fn) => fn()),
    }));
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      SettingsRevisionConflictError: MockSettingsRevisionConflictError,
      SettingsStaleMutationError: MockSettingsStaleMutationError,
      importWorkstationSettings,
    }));
    vi.doMock('@core/config/settings/desired-state-service.js', () => ({
      SettingsDesiredStateService: class {},
    }));
    vi.doMock(
      '@core/config/settings/configured-capability-normalization.js',
      () => ({ normalizeConfiguredCapabilitiesInSettings: vi.fn() }),
    );
    vi.doMock('@core/config/settings/runtime-settings-validation.js', () => ({
      validateLoadedRuntimeSettings: vi.fn(),
    }));

    const { removeAgentToolRulesFromSyncedRuntimeSettings } =
      await import('@core/config/settings/restart-sync.js');
    const binding = mcpBinding('mcp:sum', {
      required: true,
      allowedToolPatterns: ['get-sum'],
    });
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => null),
    } as never;

    await removeAgentToolRulesFromSyncedRuntimeSettings({
      runtimeHome: '/tmp/gantry-test',
      agentFolder: 'main',
      rules: ['capability:mcp.sum.read'],
      ops: {} as never,
      repositories: {
        mcpServers: {
          listAgentBindings: vi.fn(async ({ agentId }) =>
            agentId === 'agent:main' ? [binding] : [],
          ),
        },
      } as never,
      appId: 'app:test' as never,
      settingsRevisions,
    });

    expect(importWorkstationSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedMcpBindingAgentIds: ['agent:empty', 'agent:main'],
        expectedMcpBindings: [
          expect.objectContaining({
            id: binding.id,
            required: true,
            allowedToolPatterns: ['get-sum'],
          }),
        ],
      }),
      expect.objectContaining({
        agents: expect.objectContaining({
          main: expect.objectContaining({ capabilities: [] }),
        }),
      }),
    );
  });

  it('fails closed when a fleet tool-rule grant has no settings revision repository', async () => {
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(() => ({
        runtime: { deploymentMode: 'fleet' },
        agents: {
          main: { sources: { mcpServers: [] }, capabilities: [] },
        },
      })),
      saveRuntimeSettings: vi.fn(),
      activateRuntimeModelAliases: vi.fn(),
      addAgentToolRulesToRuntimeSettings: vi.fn(),
      removeAgentToolRulesFromRuntimeSettings: vi.fn(),
      withRuntimeModelAliases: vi.fn((_settings, fn) => fn()),
    }));

    const { addAgentToolRulesToSyncedRuntimeSettings } =
      await import('@core/config/settings/restart-sync.js');
    await expect(
      addAgentToolRulesToSyncedRuntimeSettings({
        runtimeHome: '/tmp/gantry-test',
        agentFolder: 'main',
        rules: ['Browser'],
        ops: {} as never,
        repositories: {
          mcpServers: { listAgentBindings: vi.fn(async () => []) },
        } as never,
        appId: 'app:test' as never,
      }),
    ).rejects.toThrow(
      'Fleet tool-rule settings mutation requires the settings revisions repository.',
    );
  });
});

function mcpBinding(serverId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `agent-mcp-binding:agent:main:${serverId}`,
    appId: 'app:test',
    agentId: 'agent:main',
    serverId,
    status: 'active',
    required: false,
    permissionPolicyIds: [],
    allowedToolPatterns: [],
    createdAt: '2026-07-21T11:00:00.000Z',
    updatedAt: '2026-07-21T11:00:00.000Z',
    ...overrides,
  };
}
