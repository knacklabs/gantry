import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-writer-'));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

describe('writeDesiredRuntimeSettings', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@core/config/settings/restart-sync.js');
    vi.doUnmock('@core/config/settings/runtime-settings.js');
    vi.doUnmock('@core/config/settings/settings-import-service.js');
    for (const runtimeHome of runtimeHomes.splice(0)) {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
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

  it('serializes file-backed writes per settings file without losing independent changes', async () => {
    const runtimeHome = makeRuntimeHome();
    const otherRuntimeHome = makeRuntimeHome();
    const actualRuntimeSettings = await vi.importActual<
      typeof import('@core/config/settings/runtime-settings.js')
    >('@core/config/settings/runtime-settings.js');
    const baseSettings = actualRuntimeSettings.loadRuntimeSettings(runtimeHome);
    const otherBaseSettings =
      actualRuntimeSettings.loadRuntimeSettings(otherRuntimeHome);
    const firstSettings = structuredClone(baseSettings);
    firstSettings.agent.name = 'First writer';
    const secondSettings = structuredClone(baseSettings);
    secondSettings.memory.dreaming.enabled =
      !secondSettings.memory.dreaming.enabled;
    const otherSettings = structuredClone(otherBaseSettings);
    otherSettings.agent.name = 'Other runtime';
    vi.resetModules();

    let releaseFirstSave!: () => void;
    const firstSaveBlocked = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const loadRuntimeSettings = vi.fn(
      actualRuntimeSettings.loadRuntimeSettings,
    );
    const saveRuntimeSettings = vi.fn(
      async (
        saveRuntimeHome: string,
        settings: Parameters<
          typeof actualRuntimeSettings.saveRuntimeSettings
        >[1],
      ) => {
        if (saveRuntimeSettings.mock.calls.length === 1) {
          await firstSaveBlocked;
        }
        actualRuntimeSettings.saveRuntimeSettings(saveRuntimeHome, settings);
      },
    );
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ...actualRuntimeSettings,
      loadRuntimeSettings,
      saveRuntimeSettings,
    }));

    const {
      configureDesiredSettingsStorageProvider,
      writeDesiredRuntimeSettings,
    } = await import('@core/config/settings/desired-settings-writer.js');
    configureDesiredSettingsStorageProvider(undefined);

    const firstWrite = writeDesiredRuntimeSettings({
      runtimeHome,
      settings: firstSettings,
      previousSettings: baseSettings,
    });
    await vi.waitFor(() =>
      expect(saveRuntimeSettings).toHaveBeenCalledTimes(1),
    );
    const secondWrite = writeDesiredRuntimeSettings({
      runtimeHome,
      settings: secondSettings,
      previousSettings: baseSettings,
    });
    let otherWriteCompleted = false;
    const otherWrite = writeDesiredRuntimeSettings({
      runtimeHome: otherRuntimeHome,
      settings: otherSettings,
      previousSettings: otherBaseSettings,
    }).then(() => {
      otherWriteCompleted = true;
    });

    let sameFileLoadsBeforeRelease = 0;
    try {
      await vi.waitFor(() => expect(otherWriteCompleted).toBe(true));
      sameFileLoadsBeforeRelease = loadRuntimeSettings.mock.calls.filter(
        ([loadedRuntimeHome]) => loadedRuntimeHome === runtimeHome,
      ).length;
    } finally {
      releaseFirstSave();
      await Promise.all([firstWrite, secondWrite, otherWrite]);
    }

    expect(sameFileLoadsBeforeRelease).toBe(1);
    const finalSettings =
      actualRuntimeSettings.loadRuntimeSettings(runtimeHome);
    expect(finalSettings.agent.name).toBe('First writer');
    expect(finalSettings.memory.dreaming.enabled).toBe(
      secondSettings.memory.dreaming.enabled,
    );
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
    ).resolves.toEqual({ reconciled: true, restartRequired: [] });
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

  it('returns restart-required classes for memory settings changes', async () => {
    const runtimeHome = makeRuntimeHome();
    const { loadRuntimeSettings } =
      await import('@core/config/settings/runtime-settings.js');
    const {
      configureDesiredSettingsStorageProvider,
      writeDesiredRuntimeSettings,
    } = await import('@core/config/settings/desired-settings-writer.js');
    configureDesiredSettingsStorageProvider(undefined);
    const previousSettings = loadRuntimeSettings(runtimeHome);
    const settings = structuredClone(previousSettings);
    settings.memory.dreaming.enabled = !settings.memory.dreaming.enabled;

    await expect(
      writeDesiredRuntimeSettings({
        runtimeHome,
        settings,
        previousSettings,
      }),
    ).resolves.toEqual({ reconciled: false, restartRequired: ['memory'] });
  });

  it('returns no restart-required classes for agent name changes', async () => {
    const runtimeHome = makeRuntimeHome();
    const { loadRuntimeSettings } =
      await import('@core/config/settings/runtime-settings.js');
    const {
      configureDesiredSettingsStorageProvider,
      writeDesiredRuntimeSettings,
    } = await import('@core/config/settings/desired-settings-writer.js');
    configureDesiredSettingsStorageProvider(undefined);
    const previousSettings = loadRuntimeSettings(runtimeHome);
    const settings = structuredClone(previousSettings);
    settings.agent.name = 'Renamed Agent';

    await expect(
      writeDesiredRuntimeSettings({
        runtimeHome,
        settings,
        previousSettings,
      }),
    ).resolves.toEqual({ reconciled: false, restartRequired: [] });
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
