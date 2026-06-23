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
});
