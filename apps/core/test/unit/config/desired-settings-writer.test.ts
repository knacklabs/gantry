import { afterEach, describe, expect, it, vi } from 'vitest';

describe('writeDesiredRuntimeSettings', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@core/config/settings/restart-sync.js');
    vi.doUnmock('@core/config/settings/runtime-settings.js');
    vi.doUnmock('@core/config/settings/settings-import-service.js');
  });

  it('propagates import failures instead of writing invalid YAML fallback', async () => {
    const loadRuntimeSettings = vi.fn();
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings: vi.fn(async () => {
        throw new Error('invalid desired state');
      }),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings,
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

    await expect(
      writeDesiredRuntimeSettings({
        runtimeHome: '/tmp/gantry-test',
        settings: { runtime: { deploymentMode: 'workstation' } } as never,
        previousSettings: {
          runtime: { deploymentMode: 'workstation' },
        } as never,
      }),
    ).rejects.toThrow('invalid desired state');
    expect(loadRuntimeSettings).not.toHaveBeenCalled();
  });

  it('fails closed instead of writing fleet settings to YAML without storage', async () => {
    const saveRuntimeSettings = vi.fn();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      saveRuntimeSettings,
      loadRuntimeSettings: vi.fn(),
    }));

    const {
      configureDesiredSettingsStorageProvider,
      writeDesiredRuntimeSettings,
    } = await import('@core/config/settings/desired-settings-writer.js');
    configureDesiredSettingsStorageProvider(async () => undefined);

    await expect(
      writeDesiredRuntimeSettings({
        runtimeHome: '/tmp/gantry-test',
        settings: { runtime: { deploymentMode: 'fleet' } } as never,
      }),
    ).rejects.toThrow('Settings mutation requires runtime storage');
    expect(saveRuntimeSettings).not.toHaveBeenCalled();
  });

  it('appends settings revisions before applying local desired state', async () => {
    const importWorkstationSettings = vi.fn(async () => ({ revision: 7 }));
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(),
    }));

    const {
      configureDesiredSettingsStorageProvider,
      writeDesiredRuntimeSettings,
    } = await import('@core/config/settings/desired-settings-writer.js');
    const settingsRevisions = {
      getLatestSettingsRevision: vi.fn(async () => null),
    } as never;
    const storageProvider = vi.fn(async () => ({
      ops: {} as never,
      repositories: {} as never,
      settingsRevisions,
    }));
    configureDesiredSettingsStorageProvider(storageProvider);

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
    expect(storageProvider).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        runtime: expect.objectContaining({ deploymentMode: 'fleet' }),
      }),
    });
  });

  it('defaults settings revisions to the default app for CLI callers', async () => {
    const importWorkstationSettings = vi.fn(async () => ({ revision: 8 }));
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(),
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

  it('propagates required revision mirror failures', async () => {
    const importWorkstationSettings = vi.fn(async () => {
      throw new Error('settings revisions unavailable');
    });
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings: vi.fn(),
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

  it('loads latest settings revision as the mutation base when storage is available', async () => {
    const fileSettings = {
      runtime: { deploymentMode: 'workstation' },
      stale: true,
    };
    const revisionSettings = {
      runtime: { deploymentMode: 'workstation' },
      stale: false,
      latest: true,
    };
    const loadRuntimeSettings = vi.fn(() => fileSettings);
    const settingsFromRevisionDocument = vi.fn(() => revisionSettings);
    vi.doMock('@core/config/settings/settings-import-service.js', () => ({
      importWorkstationSettings: vi.fn(),
      settingsFromRevisionDocument,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      loadRuntimeSettings,
    }));

    const {
      configureDesiredSettingsStorageProvider,
      loadDesiredRuntimeSettingsForWrite,
    } = await import('@core/config/settings/desired-settings-writer.js');
    const close = vi.fn(async () => {});
    configureDesiredSettingsStorageProvider(async () => ({
      ops: {} as never,
      repositories: {} as never,
      settingsRevisions: {
        getLatestSettingsRevision: vi.fn(async () => ({
          revision: 11,
          settingsDocument: { latest: true },
        })),
      } as never,
      close,
    }));

    await expect(
      loadDesiredRuntimeSettingsForWrite({ runtimeHome: '/tmp/gantry-test' }),
    ).resolves.toBe(revisionSettings);
    expect(loadRuntimeSettings).toHaveBeenCalledWith('/tmp/gantry-test');
    expect(settingsFromRevisionDocument).toHaveBeenCalledWith({
      latest: true,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
