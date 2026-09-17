import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
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
function stopRecordedChildren(home: string): void {
  const file = recordedPidsPath(home);
  if (!fs.existsSync(file)) return;
  const pids: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(pids)) throw new Error(`Invalid local PID file: ${file}`);
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    let command = '';
    try {
      command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
      });
    } catch {
      continue;
    }
    if (
      !/apps\/core\/src\/index\.ts|node_modules\/vite\/bin\/vite\.js/.test(
        command,
      )
    )
      continue;
    try {
      process.kill(-pid, 'SIGTERM');
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
function localDatabaseUrl(port: number): string {
  const url = new URL(LOCAL_DATABASE_URL);
  url.port = String(port);
  return url.toString();
}
type ManagedPostgres = {
  id: string;
  running: boolean;
  port?: number;
};
function ownedPostgres(
  repo: string,
  home: string,
): ManagedPostgres | undefined {
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
function composePostgres(
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
      ...(action === 'up' ? ['up', '--wait', '-d'] : ['rm', '--stop', '--force']),
      'postgres',
    ],
    {
      cwd: repo,
      env: { ...env, GANTRY_POSTGRES_DATA: path.join(home, 'postgres') },
      stdio: action === 'up' ? 'pipe' : 'inherit',
    },
  );
}
function dockerFailureOutput(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const result = error as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
  return [result.message, result.stdout, result.stderr]
    .map((value) => (Buffer.isBuffer(value) ? value.toString() : value || ''))
    .join('\n');
}
function hostPortConflict(error: unknown): boolean {
  return /port is already allocated|address already in use|bind:.*failed/i.test(
    dockerFailureOutput(error),
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
  let container = ownedPostgres(repo, home);
  const port = Number(new URL(url).port || '5432');
  const managedPort = container?.port;
  if (managedPort && managedPort !== port) {
    url = localDatabaseUrl(managedPort);
    env.GANTRY_DATABASE_URL = url;
    env.GANTRY_POSTGRES_PORT = String(managedPort);
  }
  if (container && !container.running) {
    composePostgres(repo, home, env, 'rm');
    container = undefined;
  }
  try {
    composePostgres(repo, home, env, 'up');
  } catch (error) {
    if (!hostPortConflict(error)) throw error;
    const partial = ownedPostgres(repo, home);
    if (partial) composePostgres(repo, home, env, 'rm');
    const fallbackPort = await freePort();
    url = localDatabaseUrl(fallbackPort);
    env.GANTRY_DATABASE_URL = url;
    env.GANTRY_POSTGRES_PORT = String(fallbackPort);
    console.warn(
      `Port ${port} is unavailable; starting managed Postgres at 127.0.0.1:${fallbackPort}.`,
    );
    composePostgres(repo, home, env, 'up');
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
  const socketPath = path.join(home, '.local-dev.sock');
  if (!fs.existsSync(socketPath)) return false;
  if (!fs.lstatSync(socketPath).isSocket())
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
      if (error.code === 'ECONNREFUSED') {
        fs.unlinkSync(socketPath);
        resolve(false);
      } else reject(error);
    });
  });
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
export async function superviseLocal(
  repo: string,
  home: string,
  env: NodeJS.ProcessEnv,
  reset?: 'reset' | 'reset-db',
): Promise<number> {
  const children = new Set<ChildProcess>();
  let stopping = false;
  let finish!: (code: number) => void;
  const completion = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const control = net.createServer();
  const socketPath = path.join(home, '.local-dev.sock');
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
          process.kill(-child.pid!, 'SIGTERM');
        } catch {
          // The child may have exited between inspection and signalling.
        }
        await Promise.race([exited, delay(5000, undefined, { ref: false })]);
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid!, 'SIGKILL');
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
        if (request.command !== 'stop' || request.home !== home) {
          socket.destroy();
          return;
        }
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
  fs.chmodSync(socketPath, 0o600);
  const onSignal = () => {
    void shutdown(0);
  };
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
      detached: true,
    });
    children.add(child);
    if (
      child.pid &&
      (args.includes('apps/core/src/index.ts') ||
        args.includes('node_modules/vite/bin/vite.js'))
    )
      recordChildPid(home, child.pid);
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
      }
      writeResetMarker(home, reset);
      await resetLocalDatabase(env.GANTRY_DATABASE_URL!);
      if (reset === 'reset') resetLocalFiles(home);
      fs.rmSync(resetMarkerPath(home), { force: true });
    }
    const settingsPath = path.join(home, 'settings.yaml');
    const origin = localOrigin(env);
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
    const port = await freePort();
    const core = launch(['--import', 'tsx', 'apps/core/src/index.ts'], {
      ...env,
      GANTRY_CONTROL_HOST: '127.0.0.1',
      GANTRY_CONTROL_PORT: String(port),
    });
    const vite = launch(
      [
        'node_modules/vite/bin/vite.js',
        '--config',
        'apps/web/vite.config.ts',
        'apps/web',
      ],
      { ...env, GANTRY_LOCAL_CORE_ORIGIN: `http://127.0.0.1:${port}` },
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
        const response = await fetch(`${origin}/healthz`, {
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
    if (!ready && !stopping)
      throw new Error(
        'Local runtime did not become healthy within 60 seconds.',
      );
    if (ready) {
      console.log('Fresh one-time browser authorization link:');
      const authorization = await launch(
        ['--import', 'tsx', 'apps/core/src/cli/index.ts', 'ui', 'authorize'],
        env,
        process.stdout.isTTY ? 'inherit' : 'ignore',
      );
      if (authorization !== 0)
        console.error(
          'Local runtime is healthy, but the browser authorization link could not be created. Run `gantry ui authorize` to retry.',
        );
      else if (!process.stdout.isTTY)
        console.log(
          `Run \`gantry ui authorize --runtime-home ${home}\` to get a one-time browser link.`,
        );
      console.log(
        `Gantry Web UI: ${origin}/ui/\nCtrl-C stops core and Vite; Postgres stays running.`,
      );
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
export async function runLocalCommand(
  home: string,
  args: string[],
): Promise<number> {
  try {
    const repo = localSourceRoot();
    validateLocalHome(home, repo);
    const command = args[0];
    if (!command) {
      console.log('Use gantry local start, reset, reset-db, or stop.');
      return 1;
    }
    if (!['start', 'reset', 'reset-db', 'stop'].includes(command))
      throw new Error('Use gantry local start, reset, reset-db, or stop.');
    validateLocalNode();
    const env = localEnvironment(home);
    const target = localDatabase(
      env.GANTRY_DATABASE_URL!,
      command.startsWith('reset'),
    );
    const origin = localOrigin(env);
    console.log(
      `Gantry home: ${home}\nDatabase: ${target.hostname}:${target.port || '5432'}${target.pathname}\nUI origin: ${origin}`,
    );
    clearStaleResetMarker(home, args.includes('--after-manual-recovery'));
    if (command === 'stop') {
      await stopLocalDevelopment(home);
      stopRecordedChildren(home);
      if (env.GANTRY_DATABASE_URL === LOCAL_DATABASE_URL) {
        const container = ownedPostgres(repo, home);
        if (container)
          execFileSync('docker', ['stop', container.id], {
            stdio: 'inherit',
          });
      } else
        console.log('Custom Postgres is externally managed; left running.');
      return 0;
    }
    if (command.startsWith('reset')) {
      assertResetOwnership(home);
      if (env.GANTRY_DATABASE_URL !== LOCAL_DATABASE_URL)
        throw new Error('Local reset requires the managed default database.');
      await stopLocalDevelopment(home);
      stopRecordedChildren(home);
    }
    if (command === 'start') stopRecordedChildren(home);
    return await superviseLocal(
      repo,
      home,
      env,
      command === 'start' ? undefined : (command as 'reset' | 'reset-db'),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
