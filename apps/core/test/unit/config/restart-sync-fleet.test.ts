import { afterEach, describe, expect, it, vi } from 'vitest';

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
    const exportCurrent = vi.fn(async () => exported);
    const importWorkstationSettings = vi.fn(async () => ({ revision: 3 }));
    vi.doMock('@core/config/settings/desired-state-service.js', () => ({
      SettingsDesiredStateService: class {
        exportCurrent() {
          return exportCurrent();
        }
      },
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(() => ({
        runtime: { deploymentMode: 'fleet' },
      })),
      saveRuntimeSettings: vi.fn(),
      activateRuntimeModelAliases: vi.fn(),
      addAgentToolRulesToRuntimeSettings: vi.fn(),
      removeAgentToolRulesFromRuntimeSettings: vi.fn(),
      withRuntimeModelAliases: vi.fn((_settings, fn) => fn()),
    }));
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings,
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

    expect(importWorkstationSettings).toHaveBeenCalledWith(
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

  it('mirrors persistent tool-rule grants through fleet settings revisions', async () => {
    const previousSettings = {
      runtime: { deploymentMode: 'fleet' },
      agents: {
        main: {
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
          settings.agents[agentFolder].capabilities.push(...rules);
        },
      ),
      removeAgentToolRulesFromRuntimeSettings: vi.fn(),
      withRuntimeModelAliases: vi.fn((_settings, fn) => fn()),
    }));
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings,
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
    await addAgentToolRulesToSyncedRuntimeSettings({
      runtimeHome: '/tmp/gantry-test',
      agentFolder: 'main',
      rules: ['Browser'],
      ops: {} as never,
      repositories: {
        mcpServers: { listAgentBindings: vi.fn(async () => []) },
      } as never,
      appId: 'app:test' as never,
      settingsRevisions,
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

  it('bases persistent tool-rule grants on the latest settings revision when the file is stale', async () => {
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
          sources: { mcpServers: [] },
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
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => ({
        revision: 11,
        settingsDocument: { latest: true },
      })),
    } as never;
    await addAgentToolRulesToSyncedRuntimeSettings({
      runtimeHome: '/tmp/gantry-test',
      agentFolder: 'main',
      rules: ['mcp__gantry__admin_permission_list'],
      ops: {} as never,
      repositories: {
        mcpServers: { listAgentBindings: vi.fn(async () => []) },
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
      }),
      expect.objectContaining({
        agents: expect.objectContaining({
          main: expect.objectContaining({
            capabilities: ['latest-rule', 'mcp__gantry__admin_permission_list'],
          }),
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
