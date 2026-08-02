import { afterEach, describe, expect, it, vi } from 'vitest';

class MockSettingsStaleMutationError extends Error {}
class MockSettingsRevisionConflictError extends Error {}
const leases = { tryAcquire: vi.fn() };

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

function mockDesiredStateApply(onDiskSettings?: unknown) {
  const reconcile = vi.fn();
  const loadRuntimeSettingsFromPath = vi.fn(() => {
    if (onDiskSettings !== undefined) return onDiskSettings;
    throw Object.assign(new Error('settings.yaml missing'), { code: 'ENOENT' });
  });
  const saveRuntimeSettings = vi.fn();
  const activateRuntimeModelAliases = vi.fn();
  vi.doMock('@core/config/settings/desired-state-service.js', () => ({
    SettingsDesiredStateService: class {
      reconcile(settings: unknown) {
        return reconcile(settings);
      }
    },
  }));
  vi.doMock('@core/config/settings/runtime-settings.js', () => ({
    loadRuntimeSettings: vi.fn(),
    loadRuntimeSettingsFromPath,
    saveRuntimeSettings,
    activateRuntimeModelAliases,
    addAgentToolRulesToRuntimeSettings: vi.fn(),
    removeAgentToolRulesFromRuntimeSettings: vi.fn(),
    withRuntimeModelAliases: vi.fn((_settings, fn) => fn()),
  }));
  vi.doMock(
    '@core/config/settings/configured-capability-normalization.js',
    () => ({
      normalizeConfiguredCapabilitiesInSettings: vi.fn(
        async ({ settings }) => ({ settings, changed: false }),
      ),
    }),
  );
  vi.doMock('@core/config/settings/runtime-settings-validation.js', () => ({
    validateLoadedRuntimeSettings: vi.fn(() => ({ ok: true })),
  }));
  return {
    activateRuntimeModelAliases,
    loadRuntimeSettingsFromPath,
    reconcile,
    saveRuntimeSettings,
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
      leases,
    });

    expect(mocks.importWorkstationSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        revisionMirror: expect.objectContaining({
          settingsRevisions,
          createdBy: 'projection-sync',
        }),
        leases,
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
      leases,
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
      leases,
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
        leases,
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
      leases,
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
        leases,
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
      leases,
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

  it('leaves failed revision projection state in place for forward correction', async () => {
    const mocks = mockDesiredStateApply();
    const failedSettings = { marker: 'failed' };
    const failure = new Error('reconcile failed');
    mocks.reconcile.mockImplementation(async (settings) => {
      if (settings === failedSettings) throw failure;
      return { invalidReferences: [] };
    });
    const reloadRuntimeState = vi.fn(async () => {});
    const { applyRuntimeSettingsDesiredState } =
      await import('@core/config/settings/restart-sync.js');

    await expect(
      applyRuntimeSettingsDesiredState({
        runtimeHome: '/tmp/gantry-test',
        settings: failedSettings as never,
        ops: {} as never,
        repositories: {} as never,
        appId: 'app:test' as never,
        forwardCorrected: true,
        reloadRuntimeState,
      }),
    ).rejects.toBe(failure);

    expect(mocks.saveRuntimeSettings).toHaveBeenCalledOnce();
    expect(mocks.saveRuntimeSettings).toHaveBeenCalledWith(
      '/tmp/gantry-test',
      failedSettings,
    );
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.loadRuntimeSettingsFromPath).not.toHaveBeenCalled();
    expect(reloadRuntimeState).not.toHaveBeenCalled();
    expect(mocks.activateRuntimeModelAliases).not.toHaveBeenCalled();
  });

  it('restores explicit previous workstation settings instead of the on-disk candidate', async () => {
    const previousSettings = { marker: 'previous' };
    const failedSettings = { marker: 'failed' };
    const onDiskCandidate = { marker: 'on-disk-candidate' };
    const mocks = mockDesiredStateApply(onDiskCandidate);
    const failure = new Error('reconcile failed');
    mocks.reconcile.mockImplementation(async (settings) => {
      if (settings === failedSettings) throw failure;
      return { invalidReferences: [] };
    });
    const reloadRuntimeState = vi.fn(async () => {});
    const { applyRuntimeSettingsDesiredState } =
      await import('@core/config/settings/restart-sync.js');

    await expect(
      applyRuntimeSettingsDesiredState({
        runtimeHome: '/tmp/gantry-test',
        settings: failedSettings as never,
        ops: {} as never,
        repositories: {} as never,
        appId: 'app:test' as never,
        forwardCorrected: false,
        previousSettings: previousSettings as never,
        reloadRuntimeState,
      }),
    ).rejects.toBe(failure);

    expect(mocks.loadRuntimeSettingsFromPath).not.toHaveBeenCalled();
    expect(mocks.saveRuntimeSettings.mock.calls).toEqual([
      ['/tmp/gantry-test', failedSettings],
      ['/tmp/gantry-test', previousSettings],
    ]);
    expect(mocks.reconcile).toHaveBeenNthCalledWith(2, previousSettings);
    expect(reloadRuntimeState).toHaveBeenCalledOnce();
    expect(mocks.activateRuntimeModelAliases).toHaveBeenCalledWith(
      previousSettings,
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
