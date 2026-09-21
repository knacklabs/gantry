import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { readEnvFile, writeEnvFile } from '../config/env/file.js';
import { resolveRuntimeHome } from '../config/settings/runtime-home.js';
import {
  createDefaultRuntimeSettings,
  ensureRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import {
  formatLocalDoctor,
  formatLocalCommand,
  formatLocalReady,
  freeLocalPort,
  localDockerPrerequisites,
  localHostPortConflict,
  localUrlAtPort,
  resolveLocalUiOrigin,
} from './local-doctor.js';
export const LOCAL_DATABASE_URL =
  'postgres://gantry_app:gantry_app_password@127.0.0.1:5432/gantry?schema=gantry';
export const LOCAL_RESET_PATHS = [
  'settings.yaml',
  '.onboarding-state.json',
  'agents',
  'data',
  'store',
  'logs',
  'artifacts',
  'run',
] as const;
const OWNERSHIP_MARKER = '.gantry-owned';
const RESET_MARKER = '.gantry-reset-in-progress';
const PID_FILE = '.gantry-local-pids';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export function localSupervisorEndpoint(
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const digest = createHash('sha1').update(path.resolve(home)).digest('hex');
    return `\\\\.\\pipe\\gantry-local-${digest}`;
  }
  return path.join(home, '.local-dev.sock');
}
export function localSpawnDetached(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}
export function terminateLocalPid(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
    });
    return;
  }
  process.kill(-pid, signal);
}
export function validateLocalNode(version = process.versions.node): void {
  if (version.split('.')[0] !== '24')
    throw new Error(
      `Gantry local development requires Node 24 (current: ${version}). Run nvm use 24.`,
    );
}
export function localSourceRoot(start = process.cwd()): string {
  let root = path.resolve(start);
  while (true) {
    if (
      fs.existsSync(path.join(root, 'apps/core/src/index.ts')) &&
      fs.existsSync(path.join(root, 'apps/web/vite.config.ts')) &&
      fs.existsSync(path.join(root, 'docker-compose.yml')) &&
      JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
        .name === '@gantry/runtime'
    )
      return root;
    const parent = path.dirname(root);
    if (parent === root)
      throw new Error(
        'gantry local requires a Gantry source checkout. Run it from the repository after npm ci.',
      );
    root = parent;
  }
}
export function resolveLocalRuntimeHome(explicit?: string): string {
  const root = localSourceRoot();
  return resolveRuntimeHome(
    explicit || process.env.GANTRY_HOME || path.join(root, '.gantry'),
  );
}
export function validateLocalHome(home: string, repo: string): void {
  const absolute = path.resolve(home);
  if (
    [path.parse(absolute).root, os.homedir(), repo].includes(absolute) ||
    repo.startsWith(`${absolute}${path.sep}`)
  )
    throw new Error(
      `Unsafe local runtime home: ${absolute}. Choose a dedicated Gantry directory.`,
    );
  for (
    let current = absolute;
    current !== path.dirname(current);
    current = path.dirname(current)
  ) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(
        `Local runtime home must not traverse a symlink: ${current}`,
      );
  }
  for (const name of ['.env', ...LOCAL_RESET_PATHS, 'postgres']) {
    const target = path.join(absolute, name);
    if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Refusing symlinked local runtime state: ${target}`);
  }
}
export function localEnvironment(home: string): NodeJS.ProcessEnv {
  const file = path.join(home, '.env');
  const freshHome = !fs.existsSync(home);
  if (freshHome) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const saved = readEnvFile(file);
  const defaults: Record<string, string> = {
    GANTRY_HOME: home,
    GANTRY_DATABASE_URL: LOCAL_DATABASE_URL,
    SECRET_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    GANTRY_CONTROL_HOST: '127.0.0.1',
    GANTRY_CONTROL_PORT: '3939',
  };
  let changed = !fs.existsSync(file);
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in saved)) {
      saved[key] = process.env[key] || value;
      changed = true;
    }
  }
  if (changed) writeEnvFile(file, saved);
  if (freshHome) {
    const marker = path.join(home, OWNERSHIP_MARKER);
    const temporary = `${marker}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${new Date().toISOString()}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, marker);
  }
  return {
    ...saved,
    ...process.env,
    GANTRY_HOME: home,
    GANTRY_PROCESS_ROLE: 'all',
  };
}
export function localOrigin(env: NodeJS.ProcessEnv): string {
  const host = env.GANTRY_CONTROL_HOST || '127.0.0.1';
  const port = Number(env.GANTRY_CONTROL_PORT);
  if (
    !LOOPBACK.has(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error(
      'Local development requires a loopback GANTRY_CONTROL_HOST and GANTRY_CONTROL_PORT between 1 and 65535.',
    );
  return new URL(`http://${host}:${port}`).origin;
}
export function localDatabase(url: string, reset = false): URL {
  const target = new URL(url);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !LOOPBACK.has(target.hostname)
  )
    throw new Error(
      'Local development refuses non-loopback Postgres targets. Set GANTRY_DATABASE_URL to a local database.',
    );
  if (
    reset &&
    (decodeURIComponent(target.pathname) !== '/gantry' ||
      (target.searchParams.get('schema') || 'gantry') !== 'gantry')
  )
    throw new Error(
      'Local reset only supports the gantry database and gantry schema.',
    );
  for (const key of ['host', 'hostaddr', 'port', 'dbname', 'service']) {
    if (target.searchParams.has(key))
      throw new Error(
        `Local database URL must not override ${key} in query parameters.`,
      );
  }
  return target;
}
export function resetLocalFiles(home: string): void {
  for (const name of LOCAL_RESET_PATHS)
    fs.rmSync(path.join(home, name), { recursive: true, force: true });
}
function resetMarkerPath(home: string): string {
  return path.join(home, RESET_MARKER);
}
function assertResetOwnership(home: string): void {
  if (!fs.existsSync(path.join(home, OWNERSHIP_MARKER)))
    throw new Error(
      `Local reset refuses unowned runtime home: ${home}. Start a fresh local runtime home first.`,
    );
}
function clearStaleResetMarker(home: string, acknowledged: boolean): void {
  const marker = resetMarkerPath(home);
  if (!fs.existsSync(marker)) return;
  const variant = fs.readFileSync(marker, 'utf8').trim() || 'reset';
  if (!acknowledged)
    throw new Error(
      `A previous ${variant} did not finish cleanly. Inspect ${home}, then rerun with --after-manual-recovery.`,
    );
  fs.unlinkSync(marker);
}
function writeResetMarker(home: string, variant: 'reset' | 'reset-db'): void {
  fs.writeFileSync(resetMarkerPath(home), variant, { mode: 0o600 });
}
function recordedPidsPath(home: string): string {
  return path.join(home, PID_FILE);
}
function recordChildPid(home: string, pid: number): void {
  const file = recordedPidsPath(home);
  const pids = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : [];
  fs.writeFileSync(file, JSON.stringify([...new Set([...pids, pid])]), {
    mode: 0o600,
  });
}
function recordedChildCommandLine(pid: number): string {
  if (process.platform === 'win32') {
    try {
      return execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8' },
      );
    } catch {
      return '';
    }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    });
  } catch {
    return '';
  }
}
function stopRecordedChildren(home: string): void {
  const file = recordedPidsPath(home);
  if (!fs.existsSync(file)) return;
  const pids: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(pids)) throw new Error(`Invalid local PID file: ${file}`);
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const command = recordedChildCommandLine(pid);
    if (
      !command ||
      !/apps\/core\/src\/index\.ts|node_modules\/vite\/bin\/vite\.js/.test(
        command,
      )
    )
      continue;
    try {
      terminateLocalPid(pid);
    } catch {
      // The child may have exited between inspection and signalling.
    }
  }
  fs.unlinkSync(file);
}
async function databaseReachable(url: string): Promise<boolean> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
type ManagedPg = { id: string; running: boolean; port?: number };
function ownedPostgres(repo: string, home: string): ManagedPg | undefined {
  let existing: string;
  try {
    existing = execFileSync(
      'docker',
      [
        'container',
        'ls',
        '-a',
        '--filter',
        'name=^/gantry-postgres$',
        '--format',
        '{{.ID}}',
      ],
      { encoding: 'utf8' },
    ).trim();
  } catch (error) {
    throw new Error(
      'Docker is unavailable. Start Docker, then rerun the local command.',
      { cause: error },
    );
  }
  if (!existing) return undefined;
  const [container] = JSON.parse(
    execFileSync('docker', ['inspect', existing], { encoding: 'utf8' }),
  );
  const mount = container.Mounts?.find(
    (entry: { Destination: string }) =>
      entry.Destination === '/var/lib/postgresql/data',
  );
  if (
    mount?.Source !== path.join(home, 'postgres') ||
    container.Config?.Labels?.['com.docker.compose.project.working_dir'] !==
      repo
  )
    throw new Error(
      'gantry-postgres belongs to another runtime home or checkout. Stop/reconfigure it explicitly, or choose a reachable custom GANTRY_DATABASE_URL.',
    );
  const port = Number(
    container.NetworkSettings?.Ports?.['5432/tcp']?.[0]?.HostPort,
  );
  return {
    id: existing,
    running: Boolean(container.State?.Running),
    port: Number.isInteger(port) && port > 0 ? port : undefined,
  };
}
function composePg(
  repo: string,
  home: string,
  env: NodeJS.ProcessEnv,
  action: 'up' | 'rm',
): void {
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      path.join(repo, 'docker-compose.yml'),
      ...(action === 'up'
        ? ['up', '--wait', '-d']
        : ['rm', '--stop', '--force']),
      'postgres',
    ],
    {
      cwd: repo,
      env: { ...env, GANTRY_POSTGRES_DATA: path.join(home, 'postgres') },
      stdio: action === 'up' ? 'pipe' : 'inherit',
    },
  );
}
export async function ensureLocalDatabase(
  repo: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let url = env.GANTRY_DATABASE_URL!;
  localDatabase(url);
  if (url !== LOCAL_DATABASE_URL) {
    if (await databaseReachable(url)) return;
    throw new Error(
      'Configured local database is unreachable. Start it or correct GANTRY_DATABASE_URL; Gantry will not replace a custom database target.',
    );
  }
  const container = ownedPostgres(repo, home);
  const port = Number(new URL(url).port || '5432');
  if (container?.port && container.port !== port) {
    url = localUrlAtPort(LOCAL_DATABASE_URL, container.port);
    env.GANTRY_DATABASE_URL = url;
    env.GANTRY_POSTGRES_PORT = String(container.port);
  }
  if (container && !container.running) composePg(repo, home, env, 'rm');
  try {
    composePg(repo, home, env, 'up');
  } catch (error) {
    if (!localHostPortConflict(error)) throw error;
    const partial = ownedPostgres(repo, home);
    if (partial) composePg(repo, home, env, 'rm');
    const fallbackPort = await freeLocalPort();
    url = localUrlAtPort(LOCAL_DATABASE_URL, fallbackPort);
    env.GANTRY_DATABASE_URL = url;
    env.GANTRY_POSTGRES_PORT = String(fallbackPort);
    console.warn(
      `Port ${port} is unavailable; starting managed Postgres at 127.0.0.1:${fallbackPort}.`,
    );
    composePg(repo, home, env, 'up');
  }
  if (!(await databaseReachable(url)))
    throw new Error(
      'Managed Postgres started but the configured database is unreachable. Check gantry-postgres logs.',
    );
}
export async function resetLocalDatabase(url: string): Promise<void> {
  localDatabase(url, true);
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const active = await client.query(
      'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
    );
    if (active.rows.length)
      throw new Error(
        'Database is in use by another process. Stop that runtime before resetting this local database.',
      );
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      'DROP SCHEMA IF EXISTS gantry CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA gantry; CREATE SCHEMA pgboss;',
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}
export async function stopLocalDevelopment(home: string): Promise<boolean> {
  const socketPath = localSupervisorEndpoint(home);
  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) return false;
  if (
    process.platform !== 'win32' &&
    !fs.lstatSync(socketPath).isSocket()
  )
    throw new Error(`Refusing non-socket supervisor path: ${socketPath}`);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setTimeout(15000, () =>
      socket.destroy(
        new Error('Local supervisor did not stop within 15 seconds.'),
      ),
    );
    socket.on('connect', () =>
      socket.write(JSON.stringify({ command: 'stop', home })),
    );
    socket.on('data', (data) => {
      response += data.toString();
    });
    socket.on('end', () =>
      response === 'gantry-local-stopped'
        ? resolve(true)
        : reject(
            new Error('Unrecognized local supervisor; refusing to stop it.'),
          ),
    );
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        if (process.platform !== 'win32')
          fs.rmSync(socketPath, { force: true });
        resolve(false);
      } else reject(error);
    });
  });
}
export async function superviseLocal(
  repo: string,
  home: string,
  env: NodeJS.ProcessEnv,
  reset?: 'reset' | 'reset-db',
  restart = true,
): Promise<number> {
  const children = new Set<ChildProcess>();
  let stopping = false;
  let finish!: (code: number) => void;
  const completion = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const control = net.createServer();
  const socketPath = localSupervisorEndpoint(home);
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await Promise.all(
      [...children].map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
        try {
          terminateLocalPid(child.pid!);
        } catch {
          // The child may have exited between inspection and signalling.
        }
        await Promise.race([exited, delay(5000, undefined, { ref: false })]);
        if (child.exitCode === null && child.signalCode === null) {
          try {
            terminateLocalPid(child.pid!, 'SIGKILL');
          } catch {
            // The child may have exited between inspection and signalling.
          }
          await exited;
        }
      }),
    );
    control.close();
    fs.rmSync(recordedPidsPath(home), { force: true });
    finish(code);
  };
  control.on('connection', (socket) => {
    socket.setTimeout(1000, () => socket.destroy());
    socket.once('data', (data) => {
      try {
        const request = JSON.parse(data.toString());
        if (request.command !== 'stop' || request.home !== home)
          return socket.destroy();
        socket.setTimeout(0);
        void shutdown(0).then(() => socket.end('gantry-local-stopped'));
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(socketPath, resolve);
  });
  if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
  const onSignal = () => void shutdown(0);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const launch = (
    args: string[],
    childEnv = env,
    stdio: 'inherit' | 'ignore' = 'inherit',
  ): Promise<number> => {
    if (stopping) throw new Error('Local startup interrupted.');
    const child = spawn(process.execPath, args, {
      cwd: repo,
      env: childEnv,
      stdio,
      detached: localSpawnDetached(),
    });
    children.add(child);
    const recordsPid =
      args.includes('apps/core/src/index.ts') ||
      args.includes('node_modules/vite/bin/vite.js');
    if (child.pid && recordsPid) recordChildPid(home, child.pid);
    return new Promise<number>((resolve) => {
      child.once('error', () => {
        children.delete(child);
        resolve(1);
      });
      child.once('exit', (code) => {
        children.delete(child);
        resolve(code ?? 1);
      });
    });
  };
  try {
    await ensureLocalDatabase(repo, home, env);
    if (reset) {
      if (fs.existsSync(path.join(home, 'settings.yaml'))) {
        try {
          const storage = await (
            await import('../adapters/storage/postgres/runtime-store.js')
          ).initializeRuntimeStorage({
            runtimeSettings: ensureRuntimeSettings(home),
          });
          const revision =
            await storage.repositories.settingsRevisions.getLatestSettingsRevision(
              'default',
            );
          if (revision)
            saveRuntimeSettings(
              home,
              (
                await import('../config/settings/settings-revision-document.js')
              ).settingsFromRevisionDocument(revision.settingsDocument),
            );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.startsWith(
              'Postgres schema migrations are not current:',
            )
          )
            throw error;
          console.log(
            'Existing database is behind the current migrations; resetting it without exporting its stale settings projection.',
          );
        }
      }
      writeResetMarker(home, reset);
      await resetLocalDatabase(env.GANTRY_DATABASE_URL!);
      if (reset === 'reset') resetLocalFiles(home);
      fs.rmSync(resetMarkerPath(home), { force: true });
    }
    const settingsPath = path.join(home, 'settings.yaml');
    const origin = await resolveLocalUiOrigin(
      env,
      localOrigin(env),
      fs.existsSync(settingsPath)
        ? ensureRuntimeSettings(home).authentication.canonicalOrigin
        : undefined,
    );
    if (!fs.existsSync(settingsPath)) {
      const settings = createDefaultRuntimeSettings();
      settings.authentication.canonicalOrigin = origin;
      saveRuntimeSettings(home, settings);
    }
    const settings = ensureRuntimeSettings(home);
    if (settings.authentication.canonicalOrigin !== origin)
      throw new Error(
        `authentication.canonical_origin is ${settings.authentication.canonicalOrigin}, but local UI origin is ${origin}. Set authentication.canonical_origin to "${origin}" in ${settingsPath}, or set GANTRY_CONTROL_HOST/GANTRY_CONTROL_PORT to match the existing origin.`,
      );
    if (
      (await launch([
        '--import',
        'tsx',
        'apps/core/src/postgres-migrate.ts',
      ])) !== 0
    )
      throw new Error('Local database migrations failed.');
    if (!restart) {
      console.log(
        'Gantry local reset complete. Run `gantry local start` when ready.',
      );
      await shutdown(0);
      return 0;
    }
    const coreOrigin = `http://127.0.0.1:${await freeLocalPort()}`;
    const core = launch(['--import', 'tsx', 'apps/core/src/index.ts'], {
      ...env,
      GANTRY_CONTROL_HOST: '127.0.0.1',
      GANTRY_CONTROL_PORT: new URL(coreOrigin).port,
    });
    const vite = launch(
      [
        'node_modules/vite/bin/vite.js',
        '--config',
        'apps/web/vite.config.ts',
        'apps/web',
      ],
      { ...env, GANTRY_LOCAL_CORE_ORIGIN: coreOrigin },
    );
    void core.then(() => {
      if (!stopping) {
        console.error('Source core exited unexpectedly.');
        void shutdown(1);
      }
    });
    void vite.then(() => {
      if (!stopping) {
        console.error('Vite exited unexpectedly.');
        void shutdown(1);
      }
    });
    let ready = false;
    for (let attempt = 0; attempt < 120 && !stopping; attempt += 1) {
      try {
        const response = await fetch(`${coreOrigin}/healthz`, {
          signal: AbortSignal.timeout(500),
        });
        if (
          response.ok &&
          ((await response.json()) as { status?: string }).status === 'ok'
        ) {
          ready = true;
          break;
        }
      } catch {
        // Health checks are expected to fail until the core process is ready.
      }
      await delay(500);
    }
    if (!ready && !stopping) throw new Error('Core readiness timed out.');
    if (ready) {
      const printAuthorizationLink =
        process.stdout.isTTY || env.GANTRY_DEV_AUTHORIZATION_LINK === '1';
      console.log('\nFresh one-time browser authorization link:');
      const authorization = await launch(
        ['--import', 'tsx', 'apps/core/src/cli/index.ts', 'ui', 'authorize'],
        env,
        printAuthorizationLink ? 'inherit' : 'ignore',
      );
      if (authorization !== 0)
        console.error(
          'Local runtime is healthy, but the browser authorization link could not be created. Run `gantry ui authorize` to retry.',
        );
      else if (!printAuthorizationLink)
        console.log(
          `Run \`gantry ui authorize --runtime-home ${home}\` to get a one-time browser link.`,
        );
      console.log(formatLocalReady(reset || 'start', origin));
    }
    return await completion;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await shutdown(1);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
export async function runLocalCommand(home: string, args: string[]) {
  try {
    const repo = localSourceRoot();
    validateLocalHome(home, repo);
    const command = args[0];
    if (!command) {
      console.log('Use gantry local start, reset, reset-db, or stop.');
      return 1;
    }
    if (!['start', 'reset', 'reset-db', 'stop', 'doctor'].includes(command))
      throw new Error(
        'Use gantry local start, reset, reset-db, stop, or doctor.',
      );
    const noStart = args[1] === '--no-start';
    if (
      args.length > 1 &&
      (command !== 'reset' || !noStart || args.length !== 2)
    )
      throw new Error('Use `gantry local reset --no-start` only with reset.');
    validateLocalNode();
    if (command === 'doctor') {
      console.log(formatLocalDoctor(home));
      return 0;
    }
    localDockerPrerequisites();
    const env = localEnvironment(home);
    const databaseUrl = env.GANTRY_DATABASE_URL!;
    const target = localDatabase(databaseUrl, command.startsWith('reset'));
    const origin = localOrigin(env);
    console.log(
      formatLocalCommand(
        command,
        home,
        `${target.hostname}:${target.port || '5432'}${target.pathname}`,
        origin,
      ),
    );
    clearStaleResetMarker(home, args.includes('--after-manual-recovery'));
    if (command === 'stop') {
      await stopLocalDevelopment(home);
      stopRecordedChildren(home);
      if (env.GANTRY_DATABASE_URL === LOCAL_DATABASE_URL) {
        const container = ownedPostgres(repo, home);
        if (container)
          execFileSync('docker', ['stop', container.id], { stdio: 'inherit' });
      } else
        console.log('Custom Postgres is externally managed; left running.');
      console.log('Gantry local stop complete.');
      return 0;
    }
    if (command.startsWith('reset')) {
      assertResetOwnership(home);
      if (env.GANTRY_DATABASE_URL !== LOCAL_DATABASE_URL)
        throw new Error('Local reset requires the managed default database.');
      await stopLocalDevelopment(home);
      stopRecordedChildren(home);
    } else if (command === 'start') {
      await stopLocalDevelopment(home);
      stopRecordedChildren(home);
    }
    const reset =
      command === 'start' ? undefined : (command as 'reset' | 'reset-db');
    return await superviseLocal(repo, home, env, reset, !noStart);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
