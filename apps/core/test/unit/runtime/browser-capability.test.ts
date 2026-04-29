import fs from 'fs';
import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let nextPid = 5000;
  const processes = new Map<
    number,
    EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> }
  >();
  const commandLines = new Map<number, string>();
  return {
    processes,
    commandLines,
    execFileSync: vi.fn((_: string, args: string[]) => {
      const pidArg = args[args.indexOf('-p') + 1];
      return commandLines.get(Number(pidArg)) ?? '';
    }),
    spawn: vi.fn((command: string, args: string[] = []) => {
      const proc = new EventEmitter() as EventEmitter & {
        pid: number;
        unref: ReturnType<typeof vi.fn>;
      };
      proc.pid = nextPid++;
      proc.unref = vi.fn();
      processes.set(proc.pid, proc);
      commandLines.set(proc.pid, [command, ...args].join(' '));
      return proc;
    }),
    release: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
  execFileSync: mocks.execFileSync,
}));

vi.mock('@core/runtime/browser-config.js', () => ({
  CHROME_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  DEFAULT_BROWSER_KEEPALIVE_MS: 60_000,
  DEFAULT_CHROME_ARGS: ['--no-first-run'],
}));

vi.mock('@core/runtime/browser-profiles.js', () => ({
  acquireProfileLock: vi.fn(async () => ({ release: mocks.release })),
  createProfile: vi.fn(() => ({
    name: 'myclaw',
    dir: '/tmp/myclaw-browser-capability-test',
    userDataDir: '/tmp/myclaw-browser-capability-test',
    statePath: '/tmp/myclaw-browser-capability-test/state.json',
    metadata: {
      created_at: '2026-04-29T00:00:00.000Z',
      last_used: '2026-04-29T00:00:00.000Z',
      auth_markers: [],
    },
  })),
  getProfile: vi.fn(() => null),
  updateProfileMetadata: vi.fn(),
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function cdpResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe('browser-capability', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let rmSyncSpy: ReturnType<typeof vi.spyOn>;
  let statSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    fs.mkdirSync('/tmp/myclaw-browser-capability-test', { recursive: true });
    fs.writeFileSync(
      '/tmp/myclaw-browser-capability-test/DevToolsActivePort',
      '4567\n/devtools/browser/test\n',
    );
    mocks.processes.clear();
    mocks.commandLines.clear();
    mocks.spawn.mockClear();
    mocks.execFileSync.mockClear();
    mocks.release.mockClear();
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    rmSyncSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined);
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      const numericPid = Number(pid);
      if (signal === 0 || signal === undefined) {
        if (mocks.processes.has(numericPid)) return true;
        throw new Error('not running');
      }
      const proc = mocks.processes.get(numericPid);
      mocks.processes.delete(numericPid);
      queueMicrotask(() => proc?.emit('close', 0, signal));
      return true;
    });
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    statSyncSpy = vi.spyOn(fs, 'statSync').mockImplementation((filePath) => {
      const value = String(filePath);
      if (value.endsWith('/Default/Cookies')) {
        return { isFile: () => true, size: 1024 } as fs.Stats;
      }
      if (value.endsWith('/Default/Login Data')) {
        return { isFile: () => true, size: 2048 } as fs.Stats;
      }
      throw new Error('missing');
    });
  });

  afterEach(async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    await manager.closeAllBrowsers();
    killSpy.mockRestore();
    existsSyncSpy.mockRestore();
    rmSyncSpy.mockRestore();
    statSyncSpy.mockRestore();
    fs.rmSync('/tmp/myclaw-browser-capability-test', {
      recursive: true,
      force: true,
    });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports running only when the CDP HTTP endpoint is healthy', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    mocks.fetch
      .mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }))
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]))
      .mockRejectedValueOnce(new Error('connection refused'));

    const launchStatus = await manager.launchBrowser();
    expect(launchStatus.headless).toBe(false);
    expect(rmSyncSpy).toHaveBeenCalledWith(
      '/tmp/myclaw-browser-capability-test/DevToolsActivePort',
      { force: true },
    );
    expect(mocks.spawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--remote-debugging-port=0']),
    );
    expect(mocks.spawn.mock.calls[0][1]).not.toContain('--headless=new');
    const status = await manager.getBrowserStatus();

    expect(status).toEqual({
      profile: 'myclaw',
      profileName: 'myclaw',
      running: false,
      cdpReady: false,
    });
    expect(killSpy).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('relaunches instead of reusing a process with an unhealthy CDP endpoint', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    mocks.fetch
      .mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }))
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }))
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-2', type: 'page' }]));

    await manager.launchBrowser();
    fs.writeFileSync(
      '/tmp/myclaw-browser-capability-test/DevToolsActivePort',
      '4568\n/devtools/browser/test\n',
    );
    const relaunched = await manager.launchBrowser();

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(relaunched).toMatchObject({
      running: true,
      port: 4568,
      targetId: 'target-2',
    });
  });

  it('uses headless mode only when explicitly requested', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    mocks.fetch
      .mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }))
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]));

    const status = await manager.launchBrowser({ headless: true });

    expect(status.headless).toBe(true);
    expect(mocks.spawn.mock.calls[0][1]).toContain('--headless=new');
  });

  it('auto-detects headless mode in CI when no explicit mode is provided', async () => {
    vi.stubEnv('CI', 'true');
    const manager = await import('@core/runtime/browser-capability.js');
    mocks.fetch
      .mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }))
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]));

    const status = await manager.launchBrowser();

    expect(status.headless).toBe(true);
    expect(mocks.spawn.mock.calls[0][1]).toContain('--headless=new');
  });

  it('adopts a healthy persisted browser session after host restart', async () => {
    const adopted = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };
    adopted.pid = 7777;
    adopted.unref = vi.fn();
    mocks.processes.set(adopted.pid, adopted);
    mocks.commandLines.set(
      adopted.pid,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/myclaw-browser-capability-test --remote-debugging-port=5678',
    );
    fs.writeFileSync(
      '/tmp/myclaw-browser-capability-test/browser-session.json',
      JSON.stringify({
        pid: adopted.pid,
        port: 5678,
        targetId: 'persisted-target',
        startedAt: '2026-04-29T00:00:00.000Z',
        lastUsedAt: '2026-04-29T00:01:00.000Z',
        headless: false,
      }),
    );
    existsSyncSpy.mockImplementation((filePath) =>
      String(filePath).endsWith('/browser-session.json'),
    );
    mocks.fetch.mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }));

    const manager = await import('@core/runtime/browser-capability.js');
    const status = await manager.launchBrowser();

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      running: true,
      port: 5678,
      pid: adopted.pid,
      targetId: 'persisted-target',
    });
  });

  it('terminates an orphaned persisted browser session with unhealthy CDP before relaunching', async () => {
    const orphan = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };
    orphan.pid = 8888;
    orphan.unref = vi.fn();
    mocks.processes.set(orphan.pid, orphan);
    mocks.commandLines.set(
      orphan.pid,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/myclaw-browser-capability-test --remote-debugging-port=5679',
    );
    fs.writeFileSync(
      '/tmp/myclaw-browser-capability-test/browser-session.json',
      JSON.stringify({
        pid: orphan.pid,
        port: 5679,
        startedAt: '2026-04-29T00:00:00.000Z',
        lastUsedAt: '2026-04-29T00:01:00.000Z',
        headless: false,
      }),
    );
    existsSyncSpy.mockImplementation((filePath) =>
      String(filePath).endsWith('/browser-session.json'),
    );
    mocks.fetch
      .mockRejectedValueOnce(new Error('cdp unavailable'))
      .mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }))
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]));

    const manager = await import('@core/runtime/browser-capability.js');
    const status = await manager.launchBrowser();

    expect(killSpy).toHaveBeenCalledWith(orphan.pid, 'SIGTERM');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({ running: true, port: 4567 });
  });

  it('does not terminate a persisted PID that is not owned by the browser profile', async () => {
    const alien = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };
    alien.pid = 9999;
    alien.unref = vi.fn();
    mocks.processes.set(alien.pid, alien);
    mocks.commandLines.set(alien.pid, '/usr/bin/other-process');
    fs.writeFileSync(
      '/tmp/myclaw-browser-capability-test/browser-session.json',
      JSON.stringify({
        pid: alien.pid,
        port: 5680,
        startedAt: '2026-04-29T00:00:00.000Z',
        lastUsedAt: '2026-04-29T00:01:00.000Z',
        headless: false,
      }),
    );
    existsSyncSpy.mockImplementation((filePath) =>
      String(filePath).endsWith('/browser-session.json'),
    );
    mocks.fetch
      .mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }))
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]));

    const manager = await import('@core/runtime/browser-capability.js');
    const status = await manager.launchBrowser();

    expect(killSpy).not.toHaveBeenCalledWith(alien.pid, 'SIGTERM');
    expect(mocks.processes.has(alien.pid)).toBe(true);
    expect(status).toMatchObject({ running: true, port: 4567 });
  });

  it('reports a healthy persisted browser session in profile listing without adopting it', async () => {
    const adopted = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };
    adopted.pid = 7778;
    adopted.unref = vi.fn();
    mocks.processes.set(adopted.pid, adopted);
    mocks.commandLines.set(
      adopted.pid,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/myclaw-browser-capability-test --remote-debugging-port=5678',
    );
    fs.writeFileSync(
      '/tmp/myclaw-browser-capability-test/browser-session.json',
      JSON.stringify({
        pid: adopted.pid,
        port: 5678,
        startedAt: '2026-04-29T00:00:00.000Z',
        lastUsedAt: '2026-04-29T00:01:00.000Z',
        headless: false,
      }),
    );
    existsSyncSpy.mockImplementation((filePath) =>
      String(filePath).endsWith('/browser-session.json'),
    );
    mocks.fetch.mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }));

    const manager = await import('@core/runtime/browser-capability.js');
    const profiles = await manager.listBrowserProfiles();

    expect(profiles[0]).toMatchObject({
      name: 'myclaw',
      running: true,
      cdpReady: true,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('reports persistent state when Chrome cookie or login stores exist', async () => {
    const manager = await import('@core/runtime/browser-capability.js');

    await expect(manager.listBrowserProfiles()).resolves.toEqual([
      {
        name: 'myclaw',
        created_at: '2026-04-29T00:00:00.000Z',
        last_used: '2026-04-29T00:00:00.000Z',
        cdp_port: undefined,
        auth_markers: ['cookies', 'login-data'],
        has_state: true,
        running: false,
        cdpReady: false,
      },
    ]);
  });
});
