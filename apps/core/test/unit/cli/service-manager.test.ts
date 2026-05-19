import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsFilePath } from '@core/config/settings/runtime-home.js';

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-service-test-'));
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
  vi.stubEnv('GANTRY_HOME', options.runtimeHome ?? createRuntimeHome());
  const actualHomeDir = os.homedir();
  vi.spyOn(os, 'homedir').mockReturnValue(options.homeDir ?? actualHomeDir);
  const platform = options.platform ?? 'unknown';
  const systemdUser = options.hasSystemdUser ?? false;
  vi.doMock('@core/infrastructure/service/platform.js', () => ({
    detectPlatform: () => platform,
    hasSystemdUser: () => systemdUser,
    tryExec: tryExecMock,
  }));
  vi.doMock('child_process', async () => {
    const actual =
      await vi.importActual<typeof import('child_process')>('child_process');
    return {
      ...actual,
      spawn: spawnMock,
    };
  });
  return import('@core/infrastructure/service/manager.js');
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
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-home-'));
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
      'gantry',
    ]);

    const installedAt = outcome.message.match(/at (.+)\.$/)?.[1];
    expect(installedAt).toBeTruthy();
    expect(fs.existsSync(installedAt!)).toBe(true);
    const unit = fs.readFileSync(installedAt!, 'utf-8');
    expect(unit).not.toContain('ExecStartPre=');
    expect(unit).not.toContain('--local-services-start');
    expect(unit).toContain('Environment="GANTRY_HOME=');
    expect(unit).toContain(`WorkingDirectory=${runtimeHome}`);
    expect(unit).toContain('StandardOutput="append:');
  });

  it('rejects control characters in systemd unit values', async () => {
    const runtimeHome = `${createRuntimeHome()}\nInjected=bad`;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-home-'));
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

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/control characters/);
    expect(tryExecMock).not.toHaveBeenCalledWith('systemctl', [
      '--user',
      'daemon-reload',
    ]);
  });

  it('starts systemd user service on linux', async () => {
    const runtimeHome = createRuntimeHome();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-home-'));
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
      'gantry',
    ]);
  });

  it('installs nohup service script without local services prestart on linux without systemd', async () => {
    const runtimeHome = createRuntimeHome();
    const mod = await loadServiceManagerWithMocks(vi.fn(), undefined, {
      platform: 'linux',
      hasSystemdUser: false,
      runtimeHome,
    });

    const outcome = mod.installService(import.meta.url, runtimeHome);

    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe('nohup');
    const script = fs.readFileSync(
      path.join(runtimeHome, 'start-gantry.sh'),
      'utf-8',
    );
    expect(script).not.toContain('--local-services-start');
    expect(script).toContain('nohup');
  });

  it('installs launchd service with GANTRY_HOME in the plist', async () => {
    const runtimeHome = createRuntimeHome();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-home-'));
    const tryExecMock = vi
      .fn()
      .mockReturnValue({ ok: true, stdout: '', stderr: '' });
    const mod = await loadServiceManagerWithMocks(vi.fn(), tryExecMock, {
      platform: 'macos',
      homeDir,
      runtimeHome,
    });

    const outcome = mod.installService(import.meta.url, runtimeHome);

    expect(outcome.ok).toBe(true);
    const plistPath = path.join(
      homeDir,
      'Library',
      'LaunchAgents',
      'com.gantry.plist',
    );
    const plist = fs.readFileSync(plistPath, 'utf-8');
    expect(plist).toContain('<key>GANTRY_HOME</key>');
    expect(plist).toContain(`<string>${runtimeHome}</string>`);
    expect(plist).not.toContain('--local-services-start');
    expect(plist).not.toContain('&quot;');
    expect(plist).not.toContain('<key>AGENT_ROOT</key>');
    expect(outcome.message).toContain('It is not started');
    expect(tryExecMock).not.toHaveBeenCalledWith(
      'launchctl',
      expect.arrayContaining(['bootstrap']),
    );
    expect(tryExecMock).not.toHaveBeenCalledWith(
      'launchctl',
      expect.arrayContaining(['kickstart']),
    );
  });

  it('bootstraps and kickstarts launchd service on start', async () => {
    const runtimeHome = createRuntimeHome();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-home-'));
    const tryExecMock = vi.fn((command: string, args: string[]) => {
      if (command === 'launchctl' && args[0] === 'print') {
        return { ok: false, stdout: '', stderr: 'not loaded' };
      }
      return { ok: true, stdout: '', stderr: '' };
    });
    const mod = await loadServiceManagerWithMocks(vi.fn(), tryExecMock, {
      platform: 'macos',
      homeDir,
      runtimeHome,
    });

    const installOutcome = mod.installService(import.meta.url, runtimeHome);
    const startOutcome = mod.startService(runtimeHome);

    expect(installOutcome.ok).toBe(true);
    expect(startOutcome.ok).toBe(true);
    expect(tryExecMock).toHaveBeenCalledWith('launchctl', [
      'bootstrap',
      expect.stringMatching(/^gui\//),
      path.join(homeDir, 'Library', 'LaunchAgents', 'com.gantry.plist'),
    ]);
    expect(tryExecMock).toHaveBeenCalledWith('launchctl', [
      'kickstart',
      '-k',
      expect.stringMatching(/^gui\/\d+\/com\.gantry$/),
    ]);
  });

  it('kickstarts loaded launchd service without bootstrapping again', async () => {
    const runtimeHome = createRuntimeHome();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-home-'));
    const tryExecMock = vi.fn((command: string, args: string[]) => {
      if (command === 'launchctl' && args[0] === 'print') {
        return { ok: true, stdout: '\tstate = running\n', stderr: '' };
      }
      return { ok: true, stdout: '', stderr: '' };
    });
    const mod = await loadServiceManagerWithMocks(vi.fn(), tryExecMock, {
      platform: 'macos',
      homeDir,
      runtimeHome,
    });

    const installOutcome = mod.installService(import.meta.url, runtimeHome);
    const startOutcome = mod.startService(runtimeHome);

    expect(installOutcome.ok).toBe(true);
    expect(startOutcome.ok).toBe(true);
    expect(tryExecMock).not.toHaveBeenCalledWith(
      'launchctl',
      expect.arrayContaining(['bootstrap']),
    );
    expect(tryExecMock).toHaveBeenCalledWith('launchctl', [
      'kickstart',
      '-k',
      expect.stringMatching(/^gui\/\d+\/com\.gantry$/),
    ]);
  });

  it('reports launchd running state with pid', async () => {
    const runtimeHome = createRuntimeHome();
    const tryExecMock = vi.fn((command: string, args: string[]) => {
      if (command === 'launchctl' && args[0] === 'print') {
        return {
          ok: true,
          stdout: '\tstate = running\n\tpid = 1234\n',
          stderr: '',
        };
      }
      return { ok: true, stdout: '', stderr: '' };
    });
    const mod = await loadServiceManagerWithMocks(vi.fn(), tryExecMock, {
      platform: 'macos',
      runtimeHome,
    });

    const status = mod.getServiceStatus(runtimeHome);

    expect(status).toEqual({ kind: 'launchd', status: 'running(pid:1234)' });
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
      if (path.basename(String(file)) === 'gantry.pid') {
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
      (call) => path.basename(String(call[0])) === 'gantry.pid',
    );
    expect(pidCallIndex).toBeGreaterThanOrEqual(0);
    const pidWriteOrder = writeSpy.mock.invocationCallOrder[pidCallIndex];
    const unrefOrder = unrefSpy.mock.invocationCallOrder[0];
    expect(pidWriteOrder).toBeLessThan(unrefOrder);

    const pidPath = path.join(runtimeHome, 'gantry.pid');
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(fs.readFileSync(pidPath, 'utf-8').trim()).toBe('5555');
  });

  it('refuses to stop pid when ownership cannot be verified', async () => {
    const runtimeHome = createRuntimeHome();
    writeFallbackMetadata(runtimeHome);
    fs.writeFileSync(path.join(runtimeHome, 'gantry.pid'), '9999\n', 'utf-8');

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
    expect(outcome.message).toContain('not a Gantry process');
    expect(killSpy).toHaveBeenCalledWith(9999, 0);
    expect(killSpy).not.toHaveBeenCalledWith(9999, 'SIGTERM');
  });
});
