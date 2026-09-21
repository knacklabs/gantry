import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'node:events';
import net from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];
const originalHome = process.env.GANTRY_HOME;

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-cli-db-'));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.GANTRY_HOME;
  else process.env.GANTRY_HOME = originalHome;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@core/infrastructure/service/manager.js');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/adapters/storage/postgres/runtime-store.js');
  vi.doUnmock('@core/adapters/storage/postgres/storage-service.js');
  vi.doUnmock('@core/cli/provider.js');
  vi.doUnmock('@core/cli/provider-connect.js');
  vi.doUnmock('@core/cli/credentials.js');
  vi.doUnmock('@core/cli/onboarding-state.js');
  vi.doUnmock('@core/cli/setup-flow.js');
  vi.doUnmock('@core/cli/setup-flow-core-steps.js');
  vi.doUnmock('@core/cli/setup-add-conversation.js');
  vi.doUnmock('@core/cli/setup-credentials.js');
  vi.doUnmock('@core/cli/setup-flow-provider-steps.js');
  vi.doUnmock('@core/cli/setup-flow-final-steps.js');
  vi.doUnmock('@core/cli/setup-ready.js');
  vi.doUnmock('@core/cli/local.js');
  vi.doUnmock('@core/app/index.js');
  vi.doUnmock('@core/postgres-migrate.js');
  vi.doUnmock('@core/config/preflight.js');
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('pg');
  vi.doUnmock('node:child_process');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('source-local development', () => {
  it('uses repo-local home, exported home, then explicit home', async () => {
    const { localSourceRoot, resolveLocalRuntimeHome } =
      await import('@core/cli/local.js');
    vi.stubEnv('GANTRY_HOME', undefined);
    expect(resolveLocalRuntimeHome()).toBe(
      path.join(localSourceRoot(), '.gantry'),
    );
    vi.stubEnv('GANTRY_HOME', '/private/tmp/exported-gantry');
    expect(resolveLocalRuntimeHome()).toBe('/private/tmp/exported-gantry');
    expect(resolveLocalRuntimeHome('/private/tmp/explicit-gantry')).toBe(
      '/private/tmp/explicit-gantry',
    );
    expect(() => localSourceRoot(os.tmpdir())).toThrow('source checkout');
  });

  it('runs npm dev through a cross-platform Node wrapper', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const wrapper = fs.readFileSync('scripts/dev-local.mjs', 'utf8');
    expect(pkg.scripts.dev).toBe(
      'npm run build:contracts && node scripts/dev-local.mjs',
    );
    expect(wrapper).toContain("process.platform === 'win32' ? 'npm.cmd' : 'npm'");
    expect(wrapper).toContain("GANTRY_DEV_AUTHORIZATION_LINK: '1'");
    expect(pkg.scripts.dev).not.toContain('GANTRY_DEV_AUTHORIZATION_LINK=1');
  });

  it('uses a Windows pipe and taskkill instead of POSIX process groups', async () => {
    const execFileSync = vi.fn(() => '');
    vi.doMock('node:child_process', () => ({ execFileSync, spawn: vi.fn() }));
    const { localSupervisorEndpoint, localSpawnDetached, terminateLocalPid } =
      await import('@core/cli/local.js');

    expect(localSupervisorEndpoint('C:\\gantry', 'win32')).toMatch(
      /^\\\\\.\\pipe\\gantry-local-[a-f0-9]{40}$/,
    );
    expect(localSupervisorEndpoint('/tmp/gantry', 'darwin')).toBe(
      path.join('/tmp/gantry', '.local-dev.sock'),
    );
    expect(localSpawnDetached('win32')).toBe(false);
    expect(localSpawnDetached('linux')).toBe(true);
    terminateLocalPid(1234, 'SIGTERM', 'win32');
    expect(execFileSync).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '1234', '/t', '/f'],
      { stdio: 'ignore' },
    );
  });

  it('keeps POSIX process-group termination on Unix', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => ''),
      spawn: vi.fn(),
    }));
    const { terminateLocalPid } = await import('@core/cli/local.js');

    terminateLocalPid(1234, 'SIGTERM', 'darwin');

    expect(kill).toHaveBeenCalledWith(-1234, 'SIGTERM');
  });

  it('creates secure environment defaults and preserves existing values', async () => {
    vi.stubEnv('SECRET_ENCRYPTION_KEY', undefined);
    const { localEnvironment } = await import('@core/cli/local.js');
    const home = makeRuntimeHome();
    vi.stubEnv('GANTRY_PROCESS_ROLE', 'control');
    const first = localEnvironment(home);
    expect(first.GANTRY_PROCESS_ROLE).toBe('all');
    expect(Buffer.from(first.SECRET_ENCRYPTION_KEY!, 'base64')).toHaveLength(
      32,
    );
    expect(fs.statSync(path.join(home, '.env')).mode & 0o777).toBe(0o600);
    expect(first.GANTRY_HOME).toBe(home);
    const saved = fs.readFileSync(path.join(home, '.env'), 'utf8');
    vi.stubEnv('GANTRY_CONTROL_PORT', '54321');
    expect(localEnvironment(home).GANTRY_CONTROL_PORT).toBe('54321');
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe(saved);
    expect(localEnvironment(home).SECRET_ENCRYPTION_KEY).toBe(
      first.SECRET_ENCRYPTION_KEY,
    );
  });

  it('fills missing keys without replacing existing config', async () => {
    const { localEnvironment } = await import('@core/cli/local.js');
    const home = makeRuntimeHome();
    fs.writeFileSync(
      path.join(home, '.env'),
      'CUSTOM_VALUE=keep\nGANTRY_CONTROL_PORT=49999\n',
    );
    vi.stubEnv('GANTRY_CONTROL_PORT', undefined);
    expect(localEnvironment(home)).toMatchObject({
      CUSTOM_VALUE: 'keep',
      GANTRY_CONTROL_PORT: '49999',
    });
  });

  it('validates public origins and refuses unsafe database reset targets', async () => {
    const { localOrigin, localDatabase } = await import('@core/cli/local.js');
    expect(
      localOrigin({
        GANTRY_CONTROL_HOST: '127.0.0.1',
        GANTRY_CONTROL_PORT: '49999',
      }),
    ).toBe('http://127.0.0.1:49999');
    expect(
      localOrigin({
        GANTRY_CONTROL_HOST: '[::1]',
        GANTRY_CONTROL_PORT: '3939',
      }),
    ).toBe('http://[::1]:3939');
    expect(() =>
      localOrigin({
        GANTRY_CONTROL_HOST: '0.0.0.0',
        GANTRY_CONTROL_PORT: '3939',
      }),
    ).toThrow('loopback');
    expect(() => localOrigin({ GANTRY_CONTROL_PORT: '0' })).toThrow('65535');
    for (const url of [
      'postgres://x@example.com/gantry',
      'postgres://x@127.0.0.1/other',
      'postgres://x@127.0.0.1/gantry?host=remote',
      'postgres://x@127.0.0.1/gantry?schema=other',
    ])
      expect(() => localDatabase(url, true)).toThrow();
    expect(() =>
      localDatabase('postgres://x@127.0.0.1/gantry', true),
    ).not.toThrow();
  });

  it('full reset deletes only known state and refuses unsafe homes or symlinks', async () => {
    const {
      LOCAL_RESET_PATHS,
      resetLocalFiles,
      validateLocalHome,
      localSourceRoot,
    } = await import('@core/cli/local.js');
    const home = fs.realpathSync(makeRuntimeHome());
    for (const name of [...LOCAL_RESET_PATHS, '.env', 'unknown.txt'])
      fs.writeFileSync(path.join(home, name), 'keep');
    fs.mkdirSync(path.join(home, 'postgres'));
    resetLocalFiles(home);
    for (const name of LOCAL_RESET_PATHS)
      expect(fs.existsSync(path.join(home, name))).toBe(false);
    for (const name of ['.env', 'postgres', 'unknown.txt'])
      expect(fs.existsSync(path.join(home, name))).toBe(true);
    expect(() => validateLocalHome('/', localSourceRoot())).toThrow('Unsafe');
    expect(() =>
      validateLocalHome(localSourceRoot(), localSourceRoot()),
    ).toThrow('Unsafe');
    fs.symlinkSync(path.join(home, 'missing'), path.join(home, 'agents'));
    expect(() => validateLocalHome(home, localSourceRoot())).toThrow('symlink');
  });

  function mockDatabase() {
    const query = vi.fn(async () => ({ rows: [] }));
    const connect = vi.fn(async () => {});
    const end = vi.fn(async () => {});
    vi.doMock('pg', () => ({
      default: {
        Client: class {
          query = query;
          connect = connect;
          end = end;
        },
      },
    }));
    return { query, connect, end };
  }

  it('starts managed Compose even when a host database is reachable', async () => {
    mockDatabase();
    const execFileSync = vi.fn(() => '');
    vi.doMock('node:child_process', () => ({ execFileSync, spawn: vi.fn() }));
    const { ensureLocalDatabase, LOCAL_DATABASE_URL } =
      await import('@core/cli/local.js');
    await ensureLocalDatabase(process.cwd(), makeRuntimeHome(), {
      GANTRY_DATABASE_URL: LOCAL_DATABASE_URL,
    });
    expect(execFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['compose', 'up', '--wait', '-d', 'postgres']),
      expect.anything(),
    );
  });

  it('explains missing Docker prerequisites before local startup', async () => {
    const execFileSync = vi.fn(() => {
      const error = new Error('spawn docker ENOENT') as Error & {
        code: string;
      };
      error.code = 'ENOENT';
      throw error;
    });
    vi.doMock('node:child_process', () => ({ execFileSync, spawn: vi.fn() }));
    const { localDockerPrerequisites } =
      await import('@core/cli/local-doctor.js');

    expect(() => localDockerPrerequisites()).toThrow('Docker is not installed');
    expect(() => localDockerPrerequisites()).toThrow('not Homebrew Postgres');
  });

  it('uses an alternate UI port unless canonical origin pins the occupied port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as net.AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const { resolveLocalUiOrigin } = await import('@core/cli/local-doctor.js');
    const env = {
      GANTRY_HOME: makeRuntimeHome(),
      GANTRY_CONTROL_PORT: String(port),
    };

    await expect(resolveLocalUiOrigin(env, origin)).resolves.not.toBe(origin);
    await expect(resolveLocalUiOrigin(env, origin, origin)).rejects.toThrow(
      'authentication.canonical_origin requires',
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('starts managed Compose only for the default target with the selected home', async () => {
    const db = mockDatabase();
    const execFileSync = vi.fn(() => '');
    vi.doMock('node:child_process', () => ({ execFileSync, spawn: vi.fn() }));
    const { ensureLocalDatabase, LOCAL_DATABASE_URL } =
      await import('@core/cli/local.js');
    const home = makeRuntimeHome();
    await ensureLocalDatabase(process.cwd(), home, {
      GANTRY_DATABASE_URL: LOCAL_DATABASE_URL,
    });
    expect(execFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['compose', 'up', '--wait', '-d', 'postgres']),
      expect.objectContaining({
        env: expect.objectContaining({
          GANTRY_POSTGRES_DATA: path.join(home, 'postgres'),
        }),
      }),
    );
    execFileSync.mockClear();
    db.connect.mockRejectedValueOnce(new Error('unreachable'));
    await expect(
      ensureLocalDatabase(process.cwd(), home, {
        GANTRY_DATABASE_URL: 'postgres://x@127.0.0.1:5434/gantry',
      }),
    ).rejects.toThrow('custom database');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('retries an unavailable default port after removing its partial container', async () => {
    mockDatabase();
    const home = makeRuntimeHome();
    let partialContainer = false;
    const execFileSync = vi.fn((...args: unknown[]) => {
      const command = args[1] as string[];
      const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
      if (command[0] === 'container')
        return partialContainer ? 'container-id' : '';
      if (command[0] === 'inspect')
        return JSON.stringify([
          {
            Mounts: [
              {
                Destination: '/var/lib/postgresql/data',
                Source: path.join(home, 'postgres'),
              },
            ],
            Config: {
              Labels: {
                'com.docker.compose.project.working_dir': process.cwd(),
              },
            },
            State: { Running: false },
            NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '5432' }] } },
          },
        ]);
      if (command.includes('up') && !options?.env?.GANTRY_POSTGRES_PORT) {
        partialContainer = true;
        throw Object.assign(new Error('compose failed'), {
          stderr: 'Bind for 127.0.0.1:5432 failed: port is already allocated',
        });
      }
      if (command.includes('rm')) partialContainer = false;
      return '';
    });
    vi.doMock('node:child_process', () => ({ execFileSync, spawn: vi.fn() }));
    const { ensureLocalDatabase, LOCAL_DATABASE_URL } =
      await import('@core/cli/local.js');

    await ensureLocalDatabase(process.cwd(), home, {
      GANTRY_DATABASE_URL: LOCAL_DATABASE_URL,
    });

    expect(execFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'compose',
        'rm',
        '--stop',
        '--force',
        'postgres',
      ]),
      expect.anything(),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['compose', 'up', '--wait', '-d', 'postgres']),
      expect.objectContaining({
        env: expect.objectContaining({
          GANTRY_POSTGRES_PORT: expect.any(String),
        }),
      }),
    );
  });

  it('refuses to adopt a foreign named container', async () => {
    const db = mockDatabase();
    db.connect.mockRejectedValueOnce(new Error('not running'));
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce('container-id')
      .mockReturnValueOnce(
        JSON.stringify([
          {
            Mounts: [
              {
                Destination: '/var/lib/postgresql/data',
                Source: '/someone/else',
              },
            ],
          },
        ]),
      );
    vi.doMock('node:child_process', () => ({ execFileSync, spawn: vi.fn() }));
    const { ensureLocalDatabase, LOCAL_DATABASE_URL } =
      await import('@core/cli/local.js');
    await expect(
      ensureLocalDatabase(process.cwd(), makeRuntimeHome(), {
        GANTRY_DATABASE_URL: LOCAL_DATABASE_URL,
      }),
    ).rejects.toThrow('another runtime');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('resets exactly two schemas and refuses an active foreign DB client', async () => {
    const db = mockDatabase();
    const { resetLocalDatabase, LOCAL_DATABASE_URL } =
      await import('@core/cli/local.js');
    await resetLocalDatabase(LOCAL_DATABASE_URL);
    expect(db.query).toHaveBeenCalledWith(
      'DROP SCHEMA IF EXISTS gantry CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA gantry; CREATE SCHEMA pgboss;',
    );
    db.query.mockClear();
    db.query.mockResolvedValueOnce({ rows: [{ pid: 123 }] } as never);
    await expect(resetLocalDatabase(LOCAL_DATABASE_URL)).rejects.toThrow(
      'another process',
    );
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, 0],
    ['reset-db', 0],
    ['reset', 0],
    [undefined, 1],
  ] as const)(
    'supervises %s with migrations first, a fresh auth link, and verified stop/restart (auth exit %i)',
    async (reset, authorizationCode) => {
      mockDatabase();
      const children: Array<
        EventEmitter & {
          pid: number;
          exitCode: number | null;
          signalCode: string | null;
        }
      > = [];
      const spawn = vi.fn(
        (
          _node: string,
          args: string[],
          _options: { env: NodeJS.ProcessEnv },
        ) => {
          const child = Object.assign(new EventEmitter(), {
            pid: 900000 + children.length,
            exitCode: null as number | null,
            signalCode: null as string | null,
          });
          children.push(child);
          if (
            args.includes('apps/core/src/postgres-migrate.ts') ||
            args.includes('apps/core/src/cli/index.ts')
          )
            queueMicrotask(() => {
              child.exitCode = args.includes('apps/core/src/cli/index.ts')
                ? authorizationCode
                : 0;
              child.emit('exit', child.exitCode);
            });
          return child;
        },
      );
      vi.doMock('node:child_process', () => ({
        spawn,
        execFileSync: vi.fn(() => ''),
      }));
      vi.spyOn(process, 'kill').mockImplementation((pid) => {
        const child = children.find((entry) => entry.pid === -pid)!;
        child.signalCode = 'SIGTERM';
        child.emit('exit', null);
        return true;
      });
      const health = vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'ok' }),
      }));
      vi.stubGlobal('fetch', health);
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const { superviseLocal, stopLocalDevelopment, localEnvironment } =
        await import('@core/cli/local.js');
      const home = fs.realpathSync(makeRuntimeHome());
      const env = localEnvironment(home);
      if (reset === undefined) env.GANTRY_DEV_AUTHORIZATION_LINK = '1';
      fs.mkdirSync(path.join(home, 'artifacts'));
      fs.writeFileSync(path.join(home, 'artifacts', 'marker'), 'preserve');
      fs.writeFileSync(path.join(home, 'unknown'), 'preserve');
      const savedEnv = fs.readFileSync(path.join(home, '.env'), 'utf8');
      const running = superviseLocal(process.cwd(), home, env, reset);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4));
      expect(spawn.mock.calls[0][1]).toContain(
        'apps/core/src/postgres-migrate.ts',
      );
      expect(spawn.mock.calls[1][1]).toContain('apps/core/src/index.ts');
      expect(spawn.mock.calls[2][1]).toContain('node_modules/vite/bin/vite.js');
      expect(spawn.mock.calls[3][1]).toEqual([
        '--import',
        'tsx',
        'apps/core/src/cli/index.ts',
        'ui',
        'authorize',
      ]);
      expect(spawn.mock.calls[3][2]).toMatchObject({
        env: expect.objectContaining({
          GANTRY_HOME: home,
          GANTRY_DATABASE_URL: env.GANTRY_DATABASE_URL,
          GANTRY_CONTROL_HOST: env.GANTRY_CONTROL_HOST,
          GANTRY_CONTROL_PORT: env.GANTRY_CONTROL_PORT,
          GANTRY_PROCESS_ROLE: 'all',
        }),
      });
      if (reset === undefined)
        expect(spawn.mock.calls[3][2]).toMatchObject({ stdio: 'inherit' });
      expect(health).toHaveBeenCalledWith(
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/healthz$/),
        expect.anything(),
      );
      expect(spawn.mock.invocationCallOrder[3]).toBeGreaterThan(
        health.mock.invocationCallOrder[0],
      );
      if (authorizationCode === 0)
        expect(error).not.toHaveBeenCalledWith(
          expect.stringContaining(
            'browser authorization link could not be created',
          ),
        );
      else
        expect(error).toHaveBeenCalledWith(
          'Local runtime is healthy, but the browser authorization link could not be created. Run `gantry ui authorize` to retry.',
        );
      expect(fs.existsSync(path.join(home, 'artifacts', 'marker'))).toBe(
        reset !== 'reset',
      );
      expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe(savedEnv);
      expect(fs.existsSync(path.join(home, 'unknown'))).toBe(true);
      expect(await stopLocalDevelopment(home)).toBe(true);
      expect(await running).toBe(0);
      expect(process.kill).toHaveBeenCalledWith(-children[1].pid, 'SIGTERM');
      expect(process.kill).toHaveBeenCalledWith(-children[2].pid, 'SIGTERM');
    },
  );

  it('resets without starting core or Vite when restart is disabled', async () => {
    mockDatabase();
    const spawn = vi.fn((_node: string, _args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 900000,
        exitCode: null as number | null,
        signalCode: null as string | null,
      });
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0);
      });
      return child;
    });
    vi.doMock('node:child_process', () => ({
      spawn,
      execFileSync: vi.fn(() => ''),
    }));
    const { localEnvironment, superviseLocal } =
      await import('@core/cli/local.js');
    const home = fs.realpathSync(makeRuntimeHome());

    await expect(
      superviseLocal(
        process.cwd(),
        home,
        localEnvironment(home),
        'reset',
        false,
      ),
    ).resolves.toBe(0);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toContain(
      'apps/core/src/postgres-migrate.ts',
    );
  });
});

describe('CLI local routing', () => {
  it('uses credentials access in top-level help', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      output.push(String(message));
    });
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));
    const { main } = await import('@core/cli/index.js');

    const code = await main(['--help']);

    expect(code).toBe(0);
    expect(output.join('\n')).toContain(
      'gantry credentials model|access|browser',
    );
    expect(output.join('\n')).not.toContain('credentials capability');
  });

  it.each([
    ['welcome', 'welcome'],
    ['channel', 'channel'],
    ['model', 'model'],
    ['memory', 'memory'],
    ['credentials', 'credentials'],
    ['storage', 'storage'],
    ['verify', 'verify'],
  ] as const)(
    'starts completed setup menu choice %s at %s',
    async (choice, expectedStep) => {
      const runtimeHome = makeRuntimeHome();
      const onboarding = await import('@core/cli/onboarding-state.js');
      const state = onboarding.createInitialState(runtimeHome);
      state.status = 'completed';
      state.currentStep = 'ready';
      onboarding.writeOnboardingState(runtimeHome, state);
      const select = vi.fn(async () => choice);
      const runSetupFlow = vi.fn(async () => ({
        status: 'completed',
        runtimeHome,
        startAfterSetup: false,
      }));
      vi.doMock('@clack/prompts', () => ({
        isCancel: () => false,
        outro: vi.fn(),
        select,
        log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      }));
      vi.doMock('@core/cli/setup-flow.js', () => ({
        runSetupFlow,
      }));

      const { main } = await import('@core/cli/index.js');
      const code = await main(['--runtime-home', runtimeHome, 'setup']);

      expect(code).toBe(0);
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'What do you want to change?' }),
      );
      expect(runSetupFlow).toHaveBeenCalledWith(
        expect.objectContaining({ initialStep: expectedStep }),
      );
      expect(onboarding.readOnboardingState(runtimeHome)).toMatchObject({
        status: 'in_progress',
        currentStep: expectedStep,
      });
    },
  );

  it('skips channel reconnect steps for memory maintenance when a binding exists', async () => {
    const runtimeHome = makeRuntimeHome();
    const onboarding = await import('@core/cli/onboarding-state.js');
    const state = onboarding.createInitialState(runtimeHome);
    state.status = 'completed';
    state.currentStep = 'ready';
    onboarding.writeOnboardingState(runtimeHome, state);
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      'providers: {}\n',
    );

    const runMemoryStep = vi.fn(async () => ({ type: 'next' }));
    const runCredentialsStep = vi.fn(async () => ({ type: 'next' }));
    const runTelegramStep = vi.fn(async () => ({ type: 'next' }));
    const runSlackStep = vi.fn(async () => ({ type: 'next' }));
    const runConfigStep = vi.fn(async () => ({ type: 'next' }));
    const runGroupStep = vi.fn(async () => ({ type: 'next' }));
    const runVerifyStep = vi.fn(async () => ({ type: 'next' }));
    const runReadyStep = vi.fn(async () => ({ type: 'next' }));
    const select = vi.fn(async () => 'memory');

    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      isCancel: () => false,
      select,
      log: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        success: vi.fn(),
        step: vi.fn(),
        message: vi.fn(),
      },
    }));
    vi.doMock(
      '@core/config/settings/runtime-settings.js',
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import('@core/config/settings/runtime-settings.js')
          >();
        const settings = actual.createDefaultRuntimeSettings();
        settings.providers.slack.enabled = true;
        settings.providerAccounts.slack_default = {
          agentId: 'main_agent',
          provider: 'slack',
          label: 'Slack',
          runtimeSecretRefs: {
            bot_token: 'gantry-secret:SLACK_BOT_TOKEN',
            app_token: 'gantry-secret:SLACK_APP_TOKEN',
          },
        };
        settings.agents.main_agent = {
          name: 'Main',
          folder: 'main_agent',
          model: 'opus',
          bindings: {
            main: {
              jid: 'sl:C123',
              provider: 'slack',
              name: 'Ops',
              trigger: '@Main',
              addedAt: '2026-01-01T00:00:00.000Z',
              requiresTrigger: false,
            },
          },
          sources: { skills: [], mcpServers: [], tools: [] },
          capabilities: [],
          accessPreset: 'full',
        };
        return {
          ...actual,
          configureDesiredSettingsStorageProvider: vi.fn(),
          ensureRuntimeSettings: vi.fn(() => settings),
          loadRuntimeSettingsFromPath: vi.fn(() => settings),
        };
      },
    );
    vi.doMock('@core/cli/setup-flow-core-steps.js', () => ({
      runAddAgentSetupSlice: vi.fn(),
      runWelcomeStep: vi.fn(),
      runRuntimeHomeStep: vi.fn(),
      runStorageStep: vi.fn(),
      runChannelStep: vi.fn(),
      runModelStep: vi.fn(),
      runMemoryStep,
    }));
    vi.doMock('@core/cli/setup-credentials.js', () => ({
      runCredentialsStep,
    }));
    vi.doMock('@core/cli/setup-flow-provider-steps.js', () => ({
      runTelegramStep,
      runSlackStep,
    }));
    vi.doMock('@core/cli/setup-flow-final-steps.js', () => ({
      runConfigStep,
      runGroupStep,
      runVerifyStep,
    }));
    vi.doMock('@core/cli/setup-ready.js', () => ({
      runReadyStep,
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'setup']);

    expect(code).toBe(0);
    expect(runMemoryStep).toHaveBeenCalledTimes(1);
    expect(runCredentialsStep).toHaveBeenCalledTimes(1);
    expect(runConfigStep).toHaveBeenCalledTimes(1);
    expect(runVerifyStep).toHaveBeenCalledTimes(1);
    expect(runReadyStep).toHaveBeenCalledTimes(1);
    expect(runTelegramStep).not.toHaveBeenCalled();
    expect(runSlackStep).not.toHaveBeenCalled();
    expect(runGroupStep).not.toHaveBeenCalled();
  });

  it('runs the completed setup add-agent mini-flow', async () => {
    const runtimeHome = makeRuntimeHome();
    const onboarding = await import('@core/cli/onboarding-state.js');
    const state = onboarding.createInitialState(runtimeHome);
    state.status = 'completed';
    state.currentStep = 'ready';
    onboarding.writeOnboardingState(runtimeHome, state);
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === 'What do you want to change?') return 'add_agent';
      if (message === 'Choose this agent chat model') return 'gpt';
      if (message === 'Choose a channel to connect this agent') return 'slack';
      return 'cancel';
    });
    const text = vi.fn(async () => 'Research Bot');
    const runSetupFlow = vi.fn(async () => ({
      status: 'completed',
      runtimeHome,
      startAfterSetup: false,
    }));
    const listReadyModelCredentialProviders = vi.fn(async () => new Set());
    const promptModelCredentialPayload = vi.fn(async () => ({
      authMode: 'api_key',
      payload: { apiKey: 'sk-test' },
    }));
    const verifyModelCredentialInputWithPrompt = vi.fn(async () => ({
      type: 'verified',
    }));
    const storeModelCredentialInput = vi.fn(async () => undefined);
    const runProviderConnectCommand = vi.fn(async () => 0);
    const settings = { agents: {} as Record<string, any> };
    const writeDesiredRuntimeSettings = vi.fn(async (input) => {
      Object.assign(settings, structuredClone(input.settings));
      return { reconciled: true };
    });
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      outro: vi.fn(),
      select,
      text,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
    }));
    vi.doMock(
      '@core/config/settings/runtime-settings.js',
      async (importOriginal) => ({
        ...(await importOriginal<
          typeof import('@core/config/settings/runtime-settings.js')
        >()),
        configureDesiredSettingsStorageProvider: vi.fn(),
        ensureRuntimeSettings: vi.fn(),
        loadDesiredRuntimeSettingsForWrite: vi.fn(async () => settings),
        writeDesiredRuntimeSettings,
        ensureConfiguredAgent: vi.fn((target, input) => {
          target.agents[input.agentId] ??= {
            name: input.agentName,
            folder: input.agentFolder,
            persona: 'developer',
            bindings: {},
            sources: { skills: [], mcpServers: [], tools: [] },
            capabilities: [],
            accessPreset: 'full',
          };
        }),
      }),
    );
    vi.doMock('@core/cli/setup-flow.js', () => ({ runSetupFlow }));
    vi.doMock('@core/cli/credentials.js', () => ({
      listReadyModelCredentialProviders,
      promptModelCredentialPayload,
      verifyModelCredentialInputWithPrompt,
      storeModelCredentialInput,
    }));
    vi.doMock('@core/cli/provider-connect.js', () => ({
      runProviderConnectCommand,
    }));
    vi.doMock('@core/cli/runtime-group-db.js', () => ({
      openRuntimeGroupDb: vi.fn(async () => ({
        getAllConversationRoutes: vi.fn(async () => ({
          'slack:C123': { name: 'Research Bot', folder: 'research_bot' },
        })),
        close: vi.fn(async () => undefined),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'setup']);

    expect(code).toBe(0);
    expect(runSetupFlow).not.toHaveBeenCalled();
    expect(settings.agents.research_bot).toMatchObject({
      name: 'Research Bot',
      model: 'gpt',
    });
    expect(promptModelCredentialPayload).toHaveBeenCalledWith('openai');
    expect(verifyModelCredentialInputWithPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai', authMode: 'api_key' }),
    );
    expect(storeModelCredentialInput).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeHome, providerId: 'openai' }),
    );
    expect(runProviderConnectCommand).toHaveBeenCalledWith(
      runtimeHome,
      'slack',
      'research_bot',
      'Research Bot',
    );
  });

  it('runs the completed setup add-conversation mini-flow', async () => {
    const runtimeHome = makeRuntimeHome();
    const onboarding = await import('@core/cli/onboarding-state.js');
    const state = onboarding.createInitialState(runtimeHome);
    state.status = 'completed';
    state.currentStep = 'ready';
    onboarding.writeOnboardingState(runtimeHome, state);
    const select = vi.fn(async () => 'add_conversation');
    const runAddConversationSetupSlice = vi.fn(async () => 0);
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      outro: vi.fn(),
      select,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
    }));
    vi.doMock('@core/cli/setup-flow-core-steps.js', () => ({
      runAddConversationSetupSlice,
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'setup']);

    expect(code).toBe(0);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'What do you want to change?',
        options: expect.arrayContaining([
          expect.objectContaining({
            value: 'add_conversation',
            label: 'Add conversation to existing agent',
          }),
        ]),
      }),
    );
    expect(runAddConversationSetupSlice).toHaveBeenCalledWith(runtimeHome);
  });

  it('does not persist an add-agent when the conversation kept its existing owner', async () => {
    const runtimeHome = makeRuntimeHome();
    const onboarding = await import('@core/cli/onboarding-state.js');
    const state = onboarding.createInitialState(runtimeHome);
    state.status = 'completed';
    state.currentStep = 'ready';
    onboarding.writeOnboardingState(runtimeHome, state);
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === 'What do you want to change?') return 'add_agent';
      if (message === 'Choose this agent chat model') return 'gpt';
      if (message === 'Choose a channel to connect this agent') return 'slack';
      return 'cancel';
    });
    const text = vi.fn(async () => 'Research Bot');
    const logError = vi.fn();
    const settings = { agents: {} as Record<string, unknown> };
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      outro: vi.fn(),
      select,
      text,
      log: { error: logError, info: vi.fn(), warn: vi.fn(), success: vi.fn() },
    }));
    vi.doMock(
      '@core/config/settings/runtime-settings.js',
      async (importOriginal) => ({
        ...(await importOriginal<
          typeof import('@core/config/settings/runtime-settings.js')
        >()),
        configureDesiredSettingsStorageProvider: vi.fn(),
        ensureRuntimeSettings: vi.fn(),
        loadDesiredRuntimeSettingsForWrite: vi.fn(async () => settings),
        writeDesiredRuntimeSettings,
      }),
    );
    vi.doMock('@core/cli/setup-flow.js', () => ({
      runSetupFlow: vi.fn(),
    }));
    vi.doMock('@core/cli/credentials.js', () => ({
      listReadyModelCredentialProviders: vi.fn(async () => new Set(['openai'])),
      promptModelCredentialPayload: vi.fn(),
      verifyModelCredentialInputWithPrompt: vi.fn(),
      storeModelCredentialInput: vi.fn(),
    }));
    vi.doMock('@core/cli/provider-connect.js', () => ({
      runProviderConnectCommand: vi.fn(async () => 0),
    }));
    vi.doMock('@core/cli/runtime-group-db.js', () => ({
      openRuntimeGroupDb: vi.fn(async () => ({
        getAllConversationRoutes: vi.fn(async () => ({
          'slack:C123': { name: 'Main Agent', folder: 'main_agent' },
        })),
        close: vi.fn(async () => undefined),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'setup']);

    expect(code).toBe(1);
    // The only write is the rollback restoring pre-connect channel state.
    expect(writeDesiredRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(writeDesiredRuntimeSettings).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'cli:setup-add-agent-rollback' }),
    );
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('No conversation was bound to the new agent'),
    );
  });

  it('does not override CLI settings storage resolution when URL lives in runtime .env', async () => {
    const runtimeHome = makeRuntimeHome();
    const originalGantryHome = process.env.GANTRY_HOME;
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    delete process.env.GANTRY_DATABASE_URL;
    process.env.GANTRY_HOME = runtimeHome;
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'GANTRY_DATABASE_URL=postgres://user:pass@localhost:5432/gantry\n',
    );
    let storageProvider:
      | Parameters<
          (typeof import('@core/config/settings/runtime-settings.js'))['configureDesiredSettingsStorageProvider']
        >[0]
      | undefined;
    const initializeRuntimeStorage = vi.fn(async () => ({
      ops: {},
      repositories: { settingsRevisions: {} },
      service: { pool: {} },
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      configureDesiredSettingsStorageProvider: vi.fn((provider) => {
        storageProvider = provider;
      }),
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      tryAcquireRuntimeAdvisoryLease: vi.fn(async () => ({
        release: vi.fn(async () => {}),
      })),
      getRuntimeStorage: vi.fn(() => {
        throw new Error('runtime storage not initialized');
      }),
      initializeRuntimeStorage,
      isStorageUnavailableError: vi.fn(() => false),
    }));

    try {
      await import('@core/cli/index.js');
      await storageProvider?.({
        settings: {
          storage: {
            postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
          },
        },
      } as any);
    } finally {
      if (originalGantryHome === undefined) {
        delete process.env.GANTRY_HOME;
      } else {
        process.env.GANTRY_HOME = originalGantryHome;
      }
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
    }

    expect(initializeRuntimeStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeSettings: expect.objectContaining({
          storage: {
            postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
          },
        }),
      }),
    );
    expect(initializeRuntimeStorage.mock.calls[0]?.[0]).not.toHaveProperty(
      'storageConfig',
    );
  });

  it('bypasses top-level settings validation for local commands', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      'storage: nope\n',
    );
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const runLocalCommand = vi.fn(async () => 0);
    vi.doMock('@core/cli/local.js', () => ({
      resolveLocalRuntimeHome: () => runtimeHome,
      runLocalCommand,
    }));
    const code = await main(['--runtime-home', runtimeHome, 'local', 'status']);

    expect(code).toBe(0);
    expect(runLocalCommand).toHaveBeenCalledWith(runtimeHome, ['status']);
  });

  it('lets runtime startup handle revision authority before start preflight', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      'agent:\n  name: broken\nagent:\n  name: duplicate\n',
    );
    const startGantryRuntime = vi.fn(async () => undefined);
    const runPostgresMigrations = vi.fn(async () => undefined);
    const validateRuntimePreflightWithStorage = vi.fn(() => {
      throw new Error('CLI start should not preflight settings.yaml directly');
    });
    vi.doMock('@core/app/index.js', () => ({ startGantryRuntime }));
    vi.doMock('@core/postgres-migrate.js', () => ({ runPostgresMigrations }));
    vi.doMock('@core/config/preflight.js', () => ({
      validateRuntimePreflightWithStorage,
      formatRuntimePreflightFailure: vi.fn(),
    }));
    const log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
    };
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log,
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'start']);

    expect(code).toBe(0);
    expect(runPostgresMigrations).toHaveBeenCalledBefore(startGantryRuntime);
    expect(startGantryRuntime).toHaveBeenCalledWith();
    expect(validateRuntimePreflightWithStorage).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'gantry start runs the runtime in the FOREGROUND. Manage the background service with `gantry service install` and `gantry restart`.',
    );
  });

  it('runs migrations before smart CLI status checks', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(path.join(runtimeHome, 'settings.yaml'), 'agent: {}\n');
    const runPostgresMigrations = vi.fn(async () => undefined);
    const validateRuntimePreflightWithStorage = vi.fn(async () => ({
      ok: true,
    }));
    const hasRuntimeConfig = vi.fn(() => true);
    const hasProcessableGroupForConfiguredChannel = vi.fn(async () => true);
    const collectRuntimeStatus = vi.fn(async () => ({ doctor: { ok: true } }));
    const formatRuntimeStatus = vi.fn(() => 'ready');
    const note = vi.fn();
    vi.doMock('@core/postgres-migrate.js', () => ({ runPostgresMigrations }));
    vi.doMock('@core/config/preflight.js', () => ({
      validateRuntimePreflightWithStorage,
    }));
    vi.doMock('@core/cli/doctor.js', () => ({
      hasRuntimeConfig,
      hasProcessableGroupForConfiguredChannel,
    }));
    vi.doMock('@core/cli/status.js', () => ({
      collectRuntimeStatus,
      formatRuntimeStatus,
    }));
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome]);

    expect(code).toBe(0);
    expect(runPostgresMigrations).toHaveBeenCalledBefore(
      validateRuntimePreflightWithStorage,
    );
    expect(note).toHaveBeenCalledWith('ready', 'Status');
  });

  it('refuses unknown local commands without contacting Docker', async () => {
    const runtimeHome = makeRuntimeHome();
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { runLocalCommand } = await import('@core/cli/local.js');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runLocalCommand(runtimeHome, ['unknown']);

    expect(code).toBe(1);
    expect(note).not.toHaveBeenCalled();
  });

  it('refuses local development on unsupported Node versions', async () => {
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { validateLocalNode } = await import('@core/cli/local.js');
    expect(() => validateLocalNode('22.0.0')).toThrow('requires Node 24');
    expect(() => validateLocalNode('24.15.0')).not.toThrow();
    expect(note).not.toHaveBeenCalled();
  });

  it('routes top-level channel commands to the channel command family', async () => {
    const runtimeHome = makeRuntimeHome();
    const runProviderCommand = vi.fn(async () => 0);
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      configureDesiredSettingsStorageProvider: vi.fn(),
      ensureRuntimeSettings: vi.fn(),
      readRuntimeMemorySettingsSnapshot: vi.fn(() => ({
        memoryEnabled: false,
        storage: {
          postgresUrlEnv: 'GANTRY_DATABASE_URL',
          postgresSchema: 'gantry',
        },
        embeddings: {
          enabled: false,
          provider: 'disabled',
          model: 'text-embedding-3-small',
        },
        dreaming: { enabled: false },
        llmModels: {
          extractor: 'haiku',
          dreaming: 'sonnet',
          consolidation: 'sonnet',
        },
      })),
      readRuntimeStorageSettingsSnapshot: vi.fn(() => ({
        postgresUrlEnv: 'GANTRY_DATABASE_URL',
        postgresSchema: 'gantry',
      })),
    }));
    vi.doMock('@core/cli/provider.js', () => ({
      runProviderCommand: runProviderCommand,
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main([
      '--runtime-home',
      runtimeHome,
      'provider',
      'connect',
      'telegram',
    ]);

    expect(code).toBe(0);
    expect(runProviderCommand).toHaveBeenCalledWith(
      expect.any(String),
      runtimeHome,
      ['connect', 'telegram'],
    );
  });

  it('sets GANTRY_HOME from --runtime-home before lazy command imports', async () => {
    const runtimeHome = makeRuntimeHome();
    const originalGantryHome = process.env.GANTRY_HOME;
    delete process.env.GANTRY_HOME;
    const runModelCommand = vi.fn(async () => {
      expect(process.env.GANTRY_HOME).toBe(runtimeHome);
      return 0;
    });
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      configureDesiredSettingsStorageProvider: vi.fn(),
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/cli/model.js', () => ({ runModelCommand }));

    try {
      const { main } = await import('@core/cli/index.js');
      const code = await main(['--runtime-home', runtimeHome, 'model', 'list']);

      expect(code).toBe(0);
      expect(runModelCommand).toHaveBeenCalledWith(runtimeHome, ['list']);
    } finally {
      if (originalGantryHome === undefined) {
        delete process.env.GANTRY_HOME;
      } else {
        process.env.GANTRY_HOME = originalGantryHome;
      }
    }
  });
});
