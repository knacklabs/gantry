import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsFilePath } from '@core/cli/runtime-home.js';

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-service-test-'));
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  return home;
}

async function loadServiceManagerWithMocks(
  spawnMock: ReturnType<typeof vi.fn>,
  tryExecMock: ReturnType<typeof vi.fn> = vi
    .fn()
    .mockReturnValue({ ok: true, stdout: '', stderr: '' }),
  options: {
    platform?: 'unknown' | 'linux' | 'macos';
    hasSystemdUser?: boolean;
    homeDir?: string;
    runtimeHome?: string;
  } = {},
) {
  vi.resetModules();
  vi.stubEnv('AGENT_ROOT', options.runtimeHome ?? createRuntimeHome());
  const platform = options.platform ?? 'unknown';
  const systemdUser = options.hasSystemdUser ?? false;
  vi.doMock('@core/cli/platform.js', () => ({
    detectPlatform: () => platform,
    hasSystemdUser: () => systemdUser,
    tryExec: tryExecMock,
  }));
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return {
      ...actual,
      homedir: () => options.homeDir ?? actual.homedir(),
    };
  });
  vi.doMock('child_process', async () => {
    const actual =
      await vi.importActual<typeof import('child_process')>('child_process');
    return {
      ...actual,
      spawn: spawnMock,
    };
  });
  return import('@core/cli/service-manager.js');
}

function writeFallbackMetadata(runtimeHome: string): string {
  const runtimeEntry = path.join(runtimeHome, 'runtime-entry.js');
  fs.writeFileSync(runtimeEntry, 'console.log("ready");\n', 'utf-8');
  fs.writeFileSync(
    path.join(runtimeHome, 'service-meta.json'),
    JSON.stringify({ runtimeEntry }, null, 2),
    'utf-8',
  );
  return runtimeEntry;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('service manager background start', () => {
  it('installs systemd user service on linux', async () => {
    const runtimeHome = createRuntimeHome();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-home-'));
    const tryExecMock = vi
      .fn()
      .mockReturnValue({ ok: true, stdout: '', stderr: '' });

    const mod = await loadServiceManagerWithMocks(vi.fn(), tryExecMock, {
      platform: 'linux',
      hasSystemdUser: true,
      homeDir,
      runtimeHome,
    });
    const outcome = mod.installService(import.meta.url, runtimeHome);

    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe('systemd-user');
    expect(tryExecMock).toHaveBeenCalledWith('systemctl', [
      '--user',
      'daemon-reload',
    ]);
    expect(tryExecMock).toHaveBeenCalledWith('systemctl', [
      '--user',
      'enable',
      'myclaw',
    ]);

    const installedAt = outcome.message.match(/at (.+)\.$/)?.[1];
    expect(installedAt).toBeTruthy();
    expect(fs.existsSync(installedAt!)).toBe(true);
  });

  it('starts systemd user service on linux', async () => {
    const runtimeHome = createRuntimeHome();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-home-'));
    const tryExecMock = vi
      .fn()
      .mockReturnValue({ ok: true, stdout: '', stderr: '' });
    const mod = await loadServiceManagerWithMocks(vi.fn(), tryExecMock, {
      platform: 'linux',
      hasSystemdUser: true,
      homeDir,
      runtimeHome,
    });

    const outcome = mod.startService(runtimeHome);

    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe('systemd-user');
    expect(tryExecMock).toHaveBeenCalledWith('systemctl', [
      '--user',
      'start',
      'myclaw',
    ]);
  });

  it('creates settings.yaml on service install when missing', async () => {
    const runtimeHome = createRuntimeHome();
    expect(fs.existsSync(settingsFilePath(runtimeHome))).toBe(false);

    const mod = await loadServiceManagerWithMocks(vi.fn(), undefined, {
      runtimeHome,
    });
    const outcome = mod.installService(import.meta.url, runtimeHome);

    expect(outcome.ok).toBe(true);
    expect(fs.existsSync(settingsFilePath(runtimeHome))).toBe(true);
  });

  it('kills spawned process when pid persistence fails', async () => {
    const runtimeHome = createRuntimeHome();
    writeFallbackMetadata(runtimeHome);

    const unrefSpy = vi.fn();
    const spawnMock = vi.fn().mockReturnValue({
      pid: 4321,
      unref: unrefSpy,
    });
    const { startService } = await loadServiceManagerWithMocks(
      spawnMock,
      undefined,
      { runtimeHome },
    );

    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (path.basename(String(file)) === 'myclaw.pid') {
        throw new Error('disk full');
      }
      return originalWriteFileSync(file as any, data as any, options as any);
    });
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    const outcome = startService(runtimeHome);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('failed to persist service pid');
    expect(killSpy).toHaveBeenCalledWith(4321, 'SIGTERM');
    expect(unrefSpy).not.toHaveBeenCalled();
  });

  it('writes pid before unref on successful start', async () => {
    const runtimeHome = createRuntimeHome();
    writeFallbackMetadata(runtimeHome);

    const unrefSpy = vi.fn();
    const spawnMock = vi.fn().mockReturnValue({
      pid: 5555,
      unref: unrefSpy,
    });
    const { startService } = await loadServiceManagerWithMocks(
      spawnMock,
      undefined,
      { runtimeHome },
    );

    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const outcome = startService(runtimeHome);

    expect(outcome.ok).toBe(true);
    expect(unrefSpy).toHaveBeenCalledTimes(1);

    const pidCallIndex = writeSpy.mock.calls.findIndex(
      (call) => path.basename(String(call[0])) === 'myclaw.pid',
    );
    expect(pidCallIndex).toBeGreaterThanOrEqual(0);
    const pidWriteOrder = writeSpy.mock.invocationCallOrder[pidCallIndex];
    const unrefOrder = unrefSpy.mock.invocationCallOrder[0];
    expect(pidWriteOrder).toBeLessThan(unrefOrder);

    const pidPath = path.join(runtimeHome, 'myclaw.pid');
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(fs.readFileSync(pidPath, 'utf-8').trim()).toBe('5555');
  });

  it('refuses to stop pid when ownership cannot be verified', async () => {
    const runtimeHome = createRuntimeHome();
    writeFallbackMetadata(runtimeHome);
    fs.writeFileSync(path.join(runtimeHome, 'myclaw.pid'), '9999\n', 'utf-8');

    const tryExecMock = vi.fn((command: string) => {
      if (command === 'ps') {
        return {
          ok: true,
          stdout: '/usr/bin/node /tmp/some-other-runtime.js',
          stderr: '',
        };
      }
      return { ok: true, stdout: '', stderr: '' };
    });
    const { stopService } = await loadServiceManagerWithMocks(
      vi.fn(),
      tryExecMock,
      { runtimeHome },
    );

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const outcome = stopService(runtimeHome);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('not a MyClaw process');
    expect(killSpy).toHaveBeenCalledWith(9999, 0);
    expect(killSpy).not.toHaveBeenCalledWith(9999, 'SIGTERM');
  });
});
