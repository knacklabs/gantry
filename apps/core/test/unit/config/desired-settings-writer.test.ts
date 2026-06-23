import { afterEach, describe, expect, it, vi } from 'vitest';

describe('writeDesiredRuntimeSettings', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@core/config/settings/restart-sync.js');
    vi.doUnmock('@core/config/settings/runtime-settings.js');
    vi.doUnmock('@core/config/settings/settings-import-service.js');
  });

  it('propagates reconciliation failures instead of writing invalid YAML fallback', async () => {
    const saveRuntimeSettings = vi.fn();
    vi.doMock('@core/config/settings/restart-sync.js', () => ({
      applyRuntimeSettingsDesiredState: vi.fn(async () => {
        throw new Error('invalid desired state');
      }),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      saveRuntimeSettings,
    }));

    const {
      configureDesiredSettingsStorageProvider,
      writeDesiredRuntimeSettings,
    } = await import('@core/config/settings/desired-settings-writer.js');
    configureDesiredSettingsStorageProvider(async () => ({
      ops: {} as never,
      repositories: {} as never,
    }));

    await expect(
      writeDesiredRuntimeSettings({
        runtimeHome: '/tmp/gantry-test',
        settings: { runtime: { deploymentMode: 'workstation' } } as never,
      }),
    ).rejects.toThrow('invalid desired state');
    expect(saveRuntimeSettings).not.toHaveBeenCalled();
  });

  it('fails closed instead of writing fleet settings to YAML without storage', async () => {
    const saveRuntimeSettings = vi.fn();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      saveRuntimeSettings,
    }));

    const { writeDesiredRuntimeSettings } =
      await import('@core/config/settings/desired-settings-writer.js');

    await expect(
      writeDesiredRuntimeSettings({
        runtimeHome: '/tmp/gantry-test',
        settings: { runtime: { deploymentMode: 'fleet' } } as never,
      }),
    ).rejects.toThrow('Fleet settings mutation requires runtime storage');
    expect(saveRuntimeSettings).not.toHaveBeenCalled();
  });

  it('appends fleet settings revisions instead of applying local desired state', async () => {
    const importWorkstationSettings = vi.fn(async () => ({ revision: 7 }));
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      saveRuntimeSettings: vi.fn(),
    }));

    const {
      configureDesiredSettingsStorageProvider,
      writeDesiredRuntimeSettings,
    } = await import('@core/config/settings/desired-settings-writer.js');
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => null),
    } as never;
    configureDesiredSettingsStorageProvider(async () => ({
      ops: {} as never,
      repositories: {} as never,
      settingsRevisions,
    }));

    await expect(
      writeDesiredRuntimeSettings({
        runtimeHome: '/tmp/gantry-test',
        settings: { runtime: { deploymentMode: 'fleet' } } as never,
        previousSettings: { runtime: { deploymentMode: 'fleet' } } as never,
        appId: 'app:test' as never,
        createdBy: 'control-api:test',
      }),
    ).resolves.toEqual({ reconciled: true });
    expect(importWorkstationSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        revisionMirror: expect.objectContaining({
          settingsRevisions,
          createdBy: 'control-api:test',
        }),
        revisionMirrorRequired: true,
      }),
      expect.objectContaining({ runtime: { deploymentMode: 'fleet' } }),
    );
  });

  it('defaults fleet settings revisions to the default app for CLI callers', async () => {
    const importWorkstationSettings = vi.fn(async () => ({ revision: 8 }));
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      saveRuntimeSettings: vi.fn(),
    }));
    const {
      configureDesiredSettingsStorageProvider,
      writeDesiredRuntimeSettings,
    } = await import('@core/config/settings/desired-settings-writer.js');
    configureDesiredSettingsStorageProvider(async () => ({
      ops: {} as never,
      repositories: {} as never,
      settingsRevisions: {
        getLatestSettingsRevision: vi.fn(async () => null),
      } as never,
    }));

    await writeDesiredRuntimeSettings({
      runtimeHome: '/tmp/gantry-test',
      settings: { runtime: { deploymentMode: 'fleet' } } as never,
      previousSettings: { runtime: { deploymentMode: 'fleet' } } as never,
    });

    expect(importWorkstationSettings).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'default' }),
      expect.objectContaining({ runtime: { deploymentMode: 'fleet' } }),
    );
  });

  it('propagates required fleet mirror failures', async () => {
    const importWorkstationSettings = vi.fn(async () => {
      throw new Error('settings revisions unavailable');
    });
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      saveRuntimeSettings: vi.fn(),
    }));
    const {
      configureDesiredSettingsStorageProvider,
      writeDesiredRuntimeSettings,
    } = await import('@core/config/settings/desired-settings-writer.js');
    configureDesiredSettingsStorageProvider(async () => ({
      ops: {} as never,
      repositories: {} as never,
      settingsRevisions: {
        getLatestSettingsRevision: vi.fn(async () => ({
          revision: 4,
          settingsDocument: {
            runtime: { deploymentMode: 'fleet' },
            newer: true,
          },
        })),
      } as never,
    }));

    await expect(
      writeDesiredRuntimeSettings({
        runtimeHome: '/tmp/gantry-test',
        settings: { runtime: { deploymentMode: 'fleet' } } as never,
        previousSettings: { runtime: { deploymentMode: 'fleet' } } as never,
      }),
    ).rejects.toThrow('settings revisions unavailable');
  });
});
