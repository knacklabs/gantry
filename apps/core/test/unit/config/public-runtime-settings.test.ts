import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

async function loadConfigForRuntimeHome(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('MYCLAW_HOME', runtimeHome);
  return await import('@core/config/index.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('public runtime settings updates', () => {
  it('rejects patches that would enable dreaming while memory is disabled', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-'),
    );
    runtimeHomes.push(runtimeHome);
    const config = await loadConfigForRuntimeHome(runtimeHome);

    expect(() =>
      config.updatePublicRuntimeSettings({
        memory: { enabled: false, dreaming: { enabled: true } },
      }),
    ).toThrow('memory.dreaming.enabled requires memory.enabled=true.');

    expect(config.getPublicRuntimeSettings().memory).toEqual({
      enabled: true,
      dreaming: { enabled: false },
    });
  });

  it('rejects disabling memory when dreaming is already enabled', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-'),
    );
    runtimeHomes.push(runtimeHome);
    const config = await loadConfigForRuntimeHome(runtimeHome);

    config.updatePublicRuntimeSettings({
      memory: { dreaming: { enabled: true } },
    });

    expect(() =>
      config.updatePublicRuntimeSettings({
        memory: { enabled: false },
      }),
    ).toThrow('memory.dreaming.enabled requires memory.enabled=true.');

    expect(config.getPublicRuntimeSettings().memory).toEqual({
      enabled: true,
      dreaming: { enabled: true },
    });
  });

  it('redacts owner-defined browser usage override sites from public settings', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-'),
    );
    runtimeHomes.push(runtimeHome);
    vi.resetModules();
    vi.stubEnv('MYCLAW_HOME', runtimeHome);
    const runtimeSettings =
      await import('@core/config/settings/runtime-settings.js');
    const defaults = runtimeSettings.ensureRuntimeSettings(runtimeHome);
    defaults.browser.usage = {
      enabled: true,
      mode: 'audit',
      windowMs: 60_000,
      maxActionsPerWindow: 100,
      maxConcurrentPerSite: 2,
      overrides: {
        'example.test': { mode: 'enforce' },
      },
    };
    runtimeSettings.saveRuntimeSettings(runtimeHome, defaults);
    const config = await import('@core/config/index.js');

    expect(config.getPublicRuntimeSettings().browser.usage).toEqual({
      enabled: true,
      mode: 'audit',
      windowMs: 60_000,
      maxActionsPerWindow: 100,
      maxConcurrentPerSite: 2,
    });
  });

  it('returns effective YOLO-mode denylist while persisting only user additions', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-'),
    );
    runtimeHomes.push(runtimeHome);
    const config = await loadConfigForRuntimeHome(runtimeHome);

    const result = config.updatePublicRuntimeSettings({
      permissions: {
        yoloMode: {
          denylist: ['npm run nuke'],
          denylistPaths: ['/opt/danger/*'],
        },
        egress: {
          denylist: ['API.LinkedIn.Com.'],
        },
      },
    });

    expect(result.changed).toEqual([
      'permissions.yoloMode.denylist',
      'permissions.yoloMode.denylistPaths',
      'permissions.egress.denylist',
    ]);
    expect(result.settings.permissions.yoloMode.denylist).toEqual(
      expect.arrayContaining(['rm -rf /', 'npm run nuke']),
    );
    expect(result.settings.permissions.yoloMode.denylistPaths).toEqual(
      expect.arrayContaining(['/etc/*', '/opt/danger/*']),
    );
    expect(result.settings.permissions.egress.denylist).toEqual([
      'api.linkedin.com',
    ]);

    const raw = fs.readFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      'utf-8',
    );
    expect(raw).toContain('npm run nuke');
    expect(raw).toContain('api.linkedin.com');
    expect(raw).not.toContain('rm -rf /');
  });

  it('rejects malformed typed patch values before mutating settings', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-'),
    );
    runtimeHomes.push(runtimeHome);
    const config = await loadConfigForRuntimeHome(runtimeHome);

    expect(() =>
      config.updatePublicRuntimeSettings({
        agent: { defaultModel: 1 as never },
      }),
    ).toThrow('agent.defaultModel must be a string.');
    expect(() =>
      config.updatePublicRuntimeSettings({
        memory: { enabled: 'false' as never },
      }),
    ).toThrow('memory.enabled must be a boolean.');
    expect(() =>
      config.updatePublicRuntimeSettings({
        permissions: { yoloMode: { enabled: 'false' as never } },
      }),
    ).toThrow('permissions.yoloMode.enabled must be a boolean.');
    expect(() =>
      config.updatePublicRuntimeSettings({
        permissions: { egress: { denylist: [1 as never] } },
      }),
    ).toThrow('permissions.egress.denylist[0] must be a non-empty string.');
    expect(() =>
      config.updatePublicRuntimeSettings({
        permissions: { egress: { denylist: ['https://api.example.com'] } },
      }),
    ).toThrow(
      'permissions.egress.denylist[0] must be a hostname glob such as api.example.com or *.example.com.',
    );

    expect(config.getPublicRuntimeSettings().agent.defaultModel).toBe('');
    expect(config.getPublicRuntimeSettings().memory.enabled).toBe(true);
    expect(config.getPublicRuntimeSettings().permissions.yoloMode.enabled).toBe(
      true,
    );
    expect(
      config.getPublicRuntimeSettings().permissions.egress.denylist,
    ).toEqual([]);
  });
});
