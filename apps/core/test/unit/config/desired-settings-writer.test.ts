import { afterEach, describe, expect, it, vi } from 'vitest';

describe('writeDesiredRuntimeSettings', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@core/config/settings/restart-sync.js');
    vi.doUnmock('@core/config/settings/runtime-settings.js');
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
        settings: {} as never,
      }),
    ).rejects.toThrow('invalid desired state');
    expect(saveRuntimeSettings).not.toHaveBeenCalled();
  });
});
