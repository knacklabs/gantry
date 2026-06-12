import fs from 'fs';
import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let nextPid = 5000;
  let nextPort = 4567;
  const processes = new Map<
    number,
    EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> }
  >();
  const commandLines = new Map<number, string>();
  return {
    processes,
    commandLines,
    resetPorts: () => {
      nextPort = 4567;
    },
    createServer: vi.fn(() => {
      const server = new EventEmitter() as EventEmitter & {
        address: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        listen: ReturnType<typeof vi.fn>;
        off: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      };
      const port = nextPort++;
      server.address = vi.fn(() => ({
        address: '127.0.0.1',
        family: 'IPv4',
        port,
      }));
      server.close = vi.fn((callback?: (err?: Error) => void) => {
        queueMicrotask(() => callback?.());
        return server;
      });
      server.listen = vi.fn(
        (_port: number, _host: string, callback?: () => void) => {
          queueMicrotask(() => callback?.());
          return server;
        },
      );
      server.off = vi.fn(
        (event: string, listener: (...args: unknown[]) => void) => {
          EventEmitter.prototype.off.call(server, event, listener);
          return server;
        },
      );
      server.unref = vi.fn(() => server);
      return server;
    }),
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

vi.mock('net', () => ({
  createServer: mocks.createServer,
}));

vi.mock('@core/runtime/browser-config.js', () => ({
  DEFAULT_BROWSER_KEEPALIVE_MS: 60_000,
  DEFAULT_CHROME_ARGS: ['--no-first-run', '--window-size=1280,900'],
}));

vi.mock('@core/shared/chrome-executable.js', () => ({
  resolveChromeExecutablePath: () =>
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}));

vi.mock('@core/runtime/browser-profiles.js', () => ({
  acquireProfileLock: vi.fn(async () => ({ release: mocks.release })),
  createProfile: vi.fn((name = 'gantry') => ({
    name,
    dir: '/tmp/gantry-browser-capability-test',
    userDataDir: '/tmp/gantry-browser-capability-test',
    statePath: '/tmp/gantry-browser-capability-test/state.json',
    metadata: {
      created_at: '2026-04-29T00:00:00.000Z',
      last_used: '2026-04-29T00:00:00.000Z',
      auth_markers: [],
    },
  })),
  getProfile: vi.fn(() => null),
  isValidBrowserProfileName: vi.fn((name: string) =>
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name),
  ),
  listProfiles: vi.fn(() => []),
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
    text: async () => JSON.stringify(body),
  } as Response;
}

function cdpTextResponse(body: string): Response {
  return {
    ok: true,
    json: async () => body,
    text: async () => body,
  } as Response;
}

function cdpVersionResponse(port = 4567): Response {
  return cdpResponse({
    Browser: 'Chrome',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/root`,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function stubCdpWebSocket() {
  const sent: Array<Record<string, unknown>> = [];
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      queueMicrotask(() => this.onopen?.());
    }

    send(data: string) {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      sent.push(parsed);
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({ id: parsed.id, result: {} }),
        }),
      );
    }

    close() {
      // Caller-initiated close should not trigger onclose in these tests.
    }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket);
  return { sent };
}

function queueHealthyContentTarget(targetId = 'target-1', port = 4567) {
  const target = { id: targetId, type: 'page' };
  mocks.fetch
    .mockResolvedValueOnce(cdpVersionResponse(port))
    .mockResolvedValueOnce(cdpResponse([target]))
    .mockResolvedValueOnce(cdpResponse([target]))
    .mockResolvedValueOnce(cdpVersionResponse(port))
    .mockResolvedValueOnce(cdpResponse([target]));
}

describe('browser-capability', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let rmSyncSpy: ReturnType<typeof vi.spyOn>;
  let statSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    fs.mkdirSync('/tmp/gantry-browser-capability-test', { recursive: true });
    fs.writeFileSync(
      '/tmp/gantry-browser-capability-test/DevToolsActivePort',
      '4567\n/devtools/browser/test\n',
    );
    mocks.processes.clear();
    mocks.commandLines.clear();
    mocks.resetPorts();
    mocks.createServer.mockClear();
    mocks.spawn.mockClear();
    mocks.execFileSync.mockClear();
    mocks.release.mockClear();
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    stubCdpWebSocket();
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
    fs.rmSync('/tmp/gantry-browser-capability-test', {
      recursive: true,
      force: true,
    });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports stopped when the CDP HTTP endpoint is unhealthy', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    queueHealthyContentTarget('target-1');
    mocks.fetch.mockRejectedValueOnce(new Error('connection refused'));

    const launchStatus = await manager.launchBrowser();
    expect(launchStatus.headless).toBe(false);
    expect(rmSyncSpy).toHaveBeenCalledWith(
      '/tmp/gantry-browser-capability-test/DevToolsActivePort',
      { force: true },
    );
    expect(mocks.spawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--remote-debugging-port=4567']),
    );
    expect(mocks.spawn.mock.calls[0][1]).not.toContain(
      '--remote-debugging-port=0',
    );
    expect(mocks.spawn.mock.calls[0][1]).not.toContain(
      '--disable-blink-features=AutomationControlled',
    );
    expect(mocks.spawn.mock.calls[0][1]).not.toContain('--headless=new');
    const status = await manager.getBrowserStatus();

    expect(status).toMatchObject({
      profile: 'gantry',
      profileName: 'gantry',
      running: false,
      cdpReady: false,
      profilePersistent: false,
      chromeExecutable:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      authMarkers: [],
    });
    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('shares one cold launch across concurrent callers for the same profile', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    const profiles = await import('@core/runtime/browser-profiles.js');
    const lockCallsBefore = vi.mocked(profiles.acquireProfileLock).mock.calls
      .length;
    const cdpReady = deferred<Response>();
    const target = { id: 'target-1', type: 'page' };
    mocks.fetch
      .mockReturnValueOnce(cdpReady.promise)
      .mockResolvedValueOnce(cdpResponse([target]))
      .mockResolvedValueOnce(cdpResponse([target]))
      .mockResolvedValueOnce(cdpVersionResponse())
      .mockResolvedValueOnce(cdpResponse([target]));

    const first = manager.launchBrowser();
    const second = manager.launchBrowser();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(profiles.acquireProfileLock).toHaveBeenCalledTimes(
      lockCallsBefore + 1,
    );
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));

    cdpReady.resolve(cdpVersionResponse());

    await expect(first).resolves.toMatchObject({ running: true });
    await expect(second).resolves.toMatchObject({ running: true });
    expect(profiles.acquireProfileLock).toHaveBeenCalledTimes(
      lockCallsBefore + 1,
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not let one caller deadline poison a shared cold launch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const manager = await import('@core/runtime/browser-capability.js');
    const cdpReady = deferred<Response>();
    const target = { id: 'target-1', type: 'page' };
    mocks.fetch
      .mockReturnValueOnce(cdpReady.promise)
      .mockResolvedValueOnce(cdpResponse([target]))
      .mockResolvedValueOnce(cdpResponse([target]))
      .mockResolvedValueOnce(cdpVersionResponse())
      .mockResolvedValueOnce(cdpResponse([target]));

    const short = manager.launchBrowser({ deadlineAtMs: 1_100 });
    const shortResult = short.catch((err) => err);
    const long = manager.launchBrowser({ deadlineAtMs: 9_000 });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(101);
    expect(await shortResult).toMatchObject({
      message: 'Browser launch deadline exceeded',
    });

    vi.setSystemTime(1_200);
    cdpReady.resolve(cdpVersionResponse());
    await expect(long).resolves.toMatchObject({ running: true });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('fails the caller when the startup deadline is exhausted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const manager = await import('@core/runtime/browser-capability.js');
    // The shared cold launch still proceeds (and succeeds) underneath; an
    // already-exhausted deadline rejects only the waiting caller, it does not
    // poison the launch. Queue a healthy CDP sequence so the detached inner
    // launch can finish cleanly without killing the process or releasing the
    // lock.
    queueHealthyContentTarget('target-1');

    const launch = manager.launchBrowser({ deadlineAtMs: 999 });
    await expect(launch).rejects.toThrow('Browser launch deadline exceeded');

    // The inner launch runs detached: wait for it to reach spawn (it has to
    // walk several async hops first). The deadline must not have spawned twice,
    // terminated the process, or released the lock.
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('relaunches instead of reusing a process with an unhealthy CDP endpoint', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    queueHealthyContentTarget('target-1');
    mocks.fetch.mockRejectedValueOnce(new Error('connection refused'));
    queueHealthyContentTarget('target-2', 4568);

    await manager.launchBrowser();
    fs.writeFileSync(
      '/tmp/gantry-browser-capability-test/DevToolsActivePort',
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

  it('creates a content target and closes Chrome internal startup tabs', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    const cdp = stubCdpWebSocket();
    mocks.fetch
      .mockResolvedValueOnce(cdpVersionResponse())
      .mockResolvedValueOnce(
        cdpResponse([
          {
            id: 'new-tab',
            type: 'page',
            url: 'chrome://new-tab-page/',
          },
          {
            id: 'omnibox',
            type: 'page',
            url: 'chrome://omnibox-popup/',
          },
        ]),
      )
      .mockResolvedValueOnce(cdpTextResponse('ok'))
      .mockResolvedValueOnce(cdpTextResponse('ok'))
      .mockResolvedValueOnce(cdpResponse([]))
      .mockResolvedValueOnce(cdpResponse([]))
      .mockResolvedValueOnce(cdpResponse({ id: 'target-1', type: 'page' }))
      .mockResolvedValueOnce(cdpVersionResponse())
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]));

    const status = await manager.launchBrowser();

    expect(status.targetId).toBe('target-1');
    expect(mocks.spawn.mock.calls[0][1]).toContain('--window-size=1280,900');
    expect(mocks.spawn.mock.calls[0][1]).not.toContain(
      '--disable-blink-features=AutomationControlled',
    );
    expect(mocks.spawn.mock.calls[0][1]).not.toContain(
      '--remote-debugging-port=0',
    );
    expect(mocks.spawn.mock.calls[0][1]).not.toContain('--headless=new');
    expect(mocks.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4567/json/new?about:blank',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4567/json/close/new-tab',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4567/json/close/omnibox',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(cdp.sent).toEqual([
      {
        id: 1,
        method: 'Target.activateTarget',
        params: { targetId: 'target-1' },
      },
    ]);
  });

  it('reports known running sessions without a CDP health probe', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    queueHealthyContentTarget('target-1');
    await manager.launchBrowser();
    mocks.fetch.mockClear();

    const status = manager.getKnownBrowserStatus();

    expect(status).toMatchObject({
      running: true,
      cdpReady: true,
      port: 4567,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('returns idempotent success when closing an already stopped browser', async () => {
    const manager = await import('@core/runtime/browser-capability.js');

    await expect(manager.closeBrowser()).resolves.toMatchObject({
      closed: true,
      reason: 'not_running',
    });
  });

  it('returns diagnostic close success for a running browser session', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    queueHealthyContentTarget('target-1');

    const status = await manager.launchBrowser();
    const closed = await manager.closeBrowser();

    expect(killSpy).toHaveBeenCalledWith(status.pid, 'SIGTERM');
    expect(closed).toMatchObject({
      closed: true,
      reason: 'terminated',
    });
    expect(closed.elapsedMs).toEqual(expect.any(Number));
  });

  it('keeps the default browser visible even in CI-like environments', async () => {
    vi.stubEnv('CI', 'true');
    const manager = await import('@core/runtime/browser-capability.js');
    queueHealthyContentTarget('target-1');

    const status = await manager.launchBrowser();

    expect(status.headless).toBe(false);
    expect(mocks.spawn.mock.calls[0][1]).not.toContain('--headless=new');
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
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/gantry-browser-capability-test --remote-debugging-port=5678',
    );
    fs.writeFileSync(
      '/tmp/gantry-browser-capability-test/browser-session.json',
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

  it('refuses to adopt a non-visible persisted browser session', async () => {
    const persisted = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };
    persisted.pid = 7878;
    persisted.unref = vi.fn();
    mocks.processes.set(persisted.pid, persisted);
    mocks.commandLines.set(
      persisted.pid,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --user-data-dir=/tmp/gantry-browser-capability-test --remote-debugging-port=5680',
    );
    fs.writeFileSync(
      '/tmp/gantry-browser-capability-test/browser-session.json',
      JSON.stringify({
        pid: persisted.pid,
        port: 5680,
        targetId: 'persisted-target',
        startedAt: '2026-04-29T00:00:00.000Z',
        lastUsedAt: '2026-04-29T00:01:00.000Z',
        headless: true,
      }),
    );
    existsSyncSpy.mockImplementation((filePath) =>
      String(filePath).endsWith('/browser-session.json'),
    );
    queueHealthyContentTarget('target-visible');

    const manager = await import('@core/runtime/browser-capability.js');
    const status = await manager.launchBrowser();

    expect(killSpy).toHaveBeenCalledWith(persisted.pid, 'SIGTERM');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][1]).not.toContain('--headless=new');
    expect(status).toMatchObject({
      running: true,
      headless: false,
      port: 4567,
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
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/gantry-browser-capability-test --remote-debugging-port=5679',
    );
    fs.writeFileSync(
      '/tmp/gantry-browser-capability-test/browser-session.json',
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
      .mockResolvedValueOnce(cdpVersionResponse())
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]))
      .mockResolvedValueOnce(cdpVersionResponse())
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
      '/tmp/gantry-browser-capability-test/browser-session.json',
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
      .mockResolvedValueOnce(cdpVersionResponse())
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]))
      .mockResolvedValueOnce(cdpVersionResponse())
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
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/gantry-browser-capability-test --remote-debugging-port=5678',
    );
    fs.writeFileSync(
      '/tmp/gantry-browser-capability-test/browser-session.json',
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
      name: 'gantry',
      running: true,
      cdpReady: true,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('reports persistent state when Chrome cookie or login stores exist', async () => {
    const manager = await import('@core/runtime/browser-capability.js');

    await expect(manager.listBrowserProfiles()).resolves.toEqual([
      {
        name: 'gantry',
        created_at: '2026-04-29T00:00:00.000Z',
        last_used: '2026-04-29T00:00:00.000Z',
        cdp_port: undefined,
        auth_markers: ['cookies', 'login-data'],
        has_state: true,
        authMarkers: ['cookies', 'login-data'],
        hasState: true,
        profilePersistent: true,
        userDataDir: '/tmp/gantry-browser-capability-test',
        chromeExecutable:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: undefined,
        running: false,
        cdpReady: false,
      },
    ]);
  });
});
