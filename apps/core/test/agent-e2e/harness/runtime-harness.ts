// Packaged-runtime harness for the agent E2E gate
// (docs/architecture/agent-e2e-ci-merge-gate-goal-prompt.md, "Packaged-runtime
// E2E proofs" + "Isolation guarantee"). Test-only; never imported by src.
//
// Boots the BUILT runtime (dist/ or the CI image) against a fresh per-run
// GANTRY_HOME (mkdtemp) and a disposable per-run Postgres DATABASE created via
// the admin connection in GANTRY_TEST_DATABASE_URL. All runtime secrets are
// generated per run. The child env is constructed from scratch (never
// inherited), so model-credential env vars are UNSET unless a scenario passes
// them explicitly via `env` (env-hygiene discipline).
//
// Prerequisites:
// - local-process mode: `npm run build:runtime` must have produced dist/
//   (dist/index.js + dist/postgres-migrate.js — the same entries the launchd
//   service / `npm start` uses).
// - GANTRY_TEST_DATABASE_URL: admin/maintenance Postgres URL on a THROWAWAY
//   server or database (CI service container / local scratch DB). The server
//   must have the `vector` and `pg_trgm` extensions installed; the harness
//   enables them in each per-run database.
// - docker mode (AGENT_E2E_RUNTIME_MODE=docker): AGENT_E2E_RUNTIME_IMAGE names
//   the CI-built image. Runs with --network host (Linux CI) so the container
//   reaches the loopback DB and the control port needs no publish mapping; the
//   image sets NODE_ENV=production, so the enforcing posture applies and the
//   generated secrets satisfy the strong-secret gate.

import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';

const execFileAsync = promisify(execFile);

export type RuntimeHarnessMode = 'local-process' | 'docker';

export interface RuntimeHarnessOptions {
  /** Scopes carried by the run's generated control API key. */
  scopes?: string[];
  /** Optional fresh, non-existent home path; the harness creates/removes it. */
  runtimeHome?: string;
  /** Selected via AGENT_E2E_RUNTIME_MODE by default; local-process otherwise. */
  mode?: RuntimeHarnessMode;
  /** docker mode: image ref/digest (default env AGENT_E2E_RUNTIME_IMAGE). */
  image?: string;
  /**
   * Extra env for the runtime process/container. This is the ONLY way a model
   * credential (or any other external secret) reaches the runtime.
   */
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}

export interface RuntimeHarness {
  readonly mode: RuntimeHarnessMode;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly home: string;
  /** Per-run database URL the runtime uses (never the admin URL). */
  readonly databaseUrl: string;
  readonly databaseName: string;
  /** Generated secrets (+ scenario-provided credential values) for redaction. */
  readonly secrets: string[];
  /** Runtime stdout/stderr captured so far (evidence on failure). */
  logs(): string;
  /** Stop + start preserving home/DB (restart-survival scenarios). */
  restart(): Promise<void>;
  /** Graceful stop with SIGKILL fallback. Idempotent. */
  stop(): Promise<void>;
  /**
   * Stop, drop the per-run database, remove the home. With KEEP_EVIDENCE=1 and
   * `failed: true`, the home and database are kept for inspection.
   */
  teardown(options?: { failed?: boolean }): Promise<void>;
}

/** The user's real workstation runtime home (launchd service target). */
export function realRuntimeHome(): string {
  return path.resolve(os.homedir(), 'gantry');
}

function databaseNameOf(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

/**
 * HARD isolation guard (matrix §1 "isolation guard" scenario): the harness
 * must never touch the live local runtime. Throws if the resolved home is the
 * user's real runtime home, or if any involved database is the live `gantry`
 * database.
 */
export function assertIsolatedRuntimeTarget(input: {
  runtimeHome: string;
  databaseUrl: string;
}): void {
  const resolvedHome = path.resolve(input.runtimeHome);
  if (resolvedHome === realRuntimeHome()) {
    throw new Error(
      `Isolation guard: refusing to run against the live runtime home ${resolvedHome}. ` +
        'The harness requires a fresh disposable GANTRY_HOME.',
    );
  }
  let databaseName: string;
  try {
    databaseName = databaseNameOf(input.databaseUrl);
  } catch (err) {
    throw new Error(
      `Isolation guard: database URL is not a valid URL: ${String(err)}`,
    );
  }
  if (databaseName === 'gantry') {
    throw new Error(
      'Isolation guard: refusing to use the live `gantry` database. ' +
        'Point GANTRY_TEST_DATABASE_URL at a throwaway server/database.',
    );
  }
}

function requireAdminDatabaseUrl(): string {
  const url = process.env.GANTRY_TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'GANTRY_TEST_DATABASE_URL is required (admin URL of a throwaway Postgres).',
    );
  }
  return url;
}

function perRunDatabaseUrl(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function pickFreePort(): Promise<number> {
  // ponytail: listen(0)-then-close has a close-to-spawn race; per-run DBs and
  // fresh homes make collisions rerunnable, so no retry loop until CI shows one.
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('No port assigned')));
      }
    });
  });
}

async function withAdminClient<T>(
  adminUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function createRunDatabase(adminUrl: string): Promise<{
  databaseName: string;
  databaseUrl: string;
}> {
  const databaseName = `gantry_e2e_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  await withAdminClient(adminUrl, async (client) => {
    await client.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
  });
  const databaseUrl = perRunDatabaseUrl(adminUrl, databaseName);
  try {
    await withAdminClient(databaseUrl, async (client) => {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    });
  } catch (error) {
    await dropRunDatabase(adminUrl, databaseName).catch(() => undefined);
    throw error;
  }
  return { databaseName, databaseUrl };
}

async function dropRunDatabase(
  adminUrl: string,
  databaseName: string,
): Promise<void> {
  await withAdminClient(adminUrl, async (client) => {
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`,
    );
  });
}

async function waitForReady(input: {
  baseUrl: string;
  timeoutMs: number;
  aborted?: () => string | undefined;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastDetail = '';
  while (Date.now() < deadline) {
    const abortReason = input.aborted?.();
    if (abortReason) {
      throw new Error(`Runtime exited before ready: ${abortReason}`);
    }
    try {
      const res = await fetch(`${input.baseUrl}/readyz`);
      const body = (await res.json()) as { status?: string };
      if (res.status === 200 && body.status === 'ready') return;
      lastDetail = `status=${res.status} body=${JSON.stringify(body)}`;
    } catch (err) {
      lastDetail = String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Runtime not ready within ${input.timeoutMs}ms (last: ${lastDetail})`,
  );
}

const DEFAULT_SCOPES = ['sessions:read', 'sessions:write', 'agents:admin'];

export async function startRuntimeHarness(
  options: RuntimeHarnessOptions = {},
): Promise<RuntimeHarness> {
  const mode: RuntimeHarnessMode =
    options.mode ??
    (process.env.AGENT_E2E_RUNTIME_MODE === 'docker'
      ? 'docker'
      : 'local-process');
  const adminUrl = requireAdminDatabaseUrl();
  const requestedHome = options.runtimeHome?.trim();
  const guardedHome = requestedHome
    ? path.resolve(requestedHome)
    : path.join(os.tmpdir(), 'gantry-agent-e2e-isolation-probe');

  // Refuse an explicit real home or live admin DB before creating a temp home,
  // connecting to Postgres, or spawning a runtime.
  assertIsolatedRuntimeTarget({
    runtimeHome: guardedHome,
    databaseUrl: adminUrl,
  });
  const port = await pickFreePort();
  const home = requestedHome
    ? guardedHome
    : fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-agent-e2e-'));
  if (requestedHome) {
    fs.mkdirSync(home, { mode: 0o700 });
  }

  // Guard the generated per-run URL before handing it to the runtime.
  let databaseName: string | undefined;
  let databaseUrl: string | undefined;
  try {
    const database = await createRunDatabase(adminUrl);
    databaseName = database.databaseName;
    databaseUrl = database.databaseUrl;
    assertIsolatedRuntimeTarget({ runtimeHome: home, databaseUrl });
  } catch (error) {
    if (databaseName) {
      await dropRunDatabase(adminUrl, databaseName).catch(() => undefined);
    }
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }

  const apiKey = randomBytes(32).toString('hex');
  const secretEncryptionKey = randomBytes(32).toString('base64');
  const ipcAuthSecret = randomBytes(32).toString('hex');
  const baseUrl = `http://127.0.0.1:${port}`;
  const controlKeysJson = JSON.stringify([
    {
      kid: 'agent-e2e',
      token: apiKey,
      appId: 'default',
      scopes: options.scopes ?? DEFAULT_SCOPES,
    },
  ]);
  const secrets = [
    apiKey,
    secretEncryptionKey,
    ipcAuthSecret,
    ...Object.values(options.env ?? {}),
  ];

  // Built from scratch — the harness process env NEVER leaks into the runtime.
  const runtimeEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    GANTRY_HOME: home,
    GANTRY_DATABASE_URL: databaseUrl,
    GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING: '1',
    GANTRY_CONTROL_HOST: '127.0.0.1',
    GANTRY_CONTROL_PORT: String(port),
    GANTRY_CONTROL_API_KEYS_JSON: controlKeysJson,
    GANTRY_IPC_AUTH_SECRET: ipcAuthSecret,
    SECRET_ENCRYPTION_KEY: secretEncryptionKey,
    // Debug so live runner/subprocess stderr (streamed at logger.debug)
    // reaches the harness log; only the failure dump ever surfaces it.
    LOG_LEVEL: 'debug',
    // NODE_ENV deliberately NOT set in local-process mode: the security
    // posture stays local (the docker image pins NODE_ENV=production itself).
    ...options.env,
  };

  const readyTimeoutMs =
    options.readyTimeoutMs ?? (mode === 'docker' ? 180_000 : 90_000);
  const logPath = path.join(home, 'runtime-harness.log');
  const logs = () => {
    try {
      return fs.readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };

  let stopped = false;
  let child: ChildProcess | undefined;
  let childExit: string | undefined;
  const containerName = `gantry-agent-e2e-${randomBytes(4).toString('hex')}`;

  const repoRoot = path.resolve(import.meta.dirname, '../../../../..');
  const distEntry = path.join(repoRoot, 'dist', 'index.js');
  const distMigrate = path.join(repoRoot, 'dist', 'postgres-migrate.js');

  async function runLocalMigrations(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const migrate = spawn(process.execPath, [distMigrate], {
        cwd: repoRoot,
        env: runtimeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      migrate.stdout.on('data', (chunk) => chunks.push(chunk));
      migrate.stderr.on('data', (chunk) => chunks.push(chunk));
      migrate.once('error', reject);
      migrate.once('exit', (code) => {
        if (code === 0) resolve();
        else {
          reject(
            new Error(
              `postgres-migrate exited with ${code}: ${Buffer.concat(chunks).toString('utf8').slice(-2000)}`,
            ),
          );
        }
      });
    });
  }

  function spawnLocalRuntime(): void {
    childExit = undefined;
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const proc = spawn(process.execPath, [distEntry], {
      cwd: repoRoot,
      env: runtimeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);
    proc.once('exit', (code, signal) => {
      childExit = `code=${code} signal=${signal}`;
    });
    child = proc;
  }

  async function stopLocalRuntime(): Promise<void> {
    const proc = child;
    child = undefined;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }

  async function startDockerRuntime(): Promise<void> {
    const image = options.image ?? process.env.AGENT_E2E_RUNTIME_IMAGE?.trim();
    if (!image) {
      throw new Error(
        'docker mode requires an image ref (options.image or AGENT_E2E_RUNTIME_IMAGE)',
      );
    }
    const args = [
      'run',
      '--detach',
      '--name',
      containerName,
      // Linux CI: loopback DB + control port shared with the host directly.
      '--network',
      'host',
      // bubblewrap needs user-namespace creation (enforcing sandbox posture).
      '--security-opt',
      'seccomp=unconfined',
      '--volume',
      `${home}:/var/lib/gantry`,
    ];
    for (const [key, value] of Object.entries({
      ...runtimeEnv,
      GANTRY_HOME: '/var/lib/gantry',
      HOME: '/var/lib/gantry',
    })) {
      if (key === 'PATH') continue;
      args.push('--env', `${key}=${value}`);
    }
    args.push(image);
    await execFileAsync('docker', args);
  }

  async function dockerLogsToFile(): Promise<void> {
    try {
      const { stdout, stderr } = await execFileAsync('docker', [
        'logs',
        containerName,
      ]);
      fs.appendFileSync(logPath, stdout + stderr);
    } catch {
      // Container already gone; nothing to capture.
    }
  }

  async function start(initial: boolean): Promise<void> {
    if (mode === 'local-process') {
      if (!fs.existsSync(distEntry)) {
        throw new Error(
          `Built runtime not found at ${distEntry}. Run \`npm run build:runtime\` first.`,
        );
      }
      if (initial) await runLocalMigrations();
      spawnLocalRuntime();
    } else if (initial) {
      // The image entrypoint runs migrations itself before dist/index.js.
      await startDockerRuntime();
    } else {
      await execFileAsync('docker', ['restart', containerName]);
    }
    await waitForReady({
      baseUrl,
      timeoutMs: readyTimeoutMs,
      aborted: mode === 'local-process' ? () => childExit : undefined,
    });
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    if (mode === 'local-process') {
      await stopLocalRuntime();
    } else {
      await dockerLogsToFile();
      await execFileAsync('docker', ['stop', '-t', '10', containerName]).catch(
        () => undefined,
      );
    }
  }

  try {
    await start(true);
  } catch (err) {
    await stop();
    stopped = true;
    if (mode === 'docker') {
      await execFileAsync('docker', ['rm', '-f', containerName]).catch(
        () => undefined,
      );
    }
    const tail = logs().slice(-4000);
    await dropRunDatabase(adminUrl, databaseName).catch(() => undefined);
    fs.rmSync(home, { recursive: true, force: true });
    throw new Error(`${String(err)}\n--- runtime log tail ---\n${tail}`);
  }

  return {
    mode,
    baseUrl,
    apiKey,
    home,
    databaseUrl,
    databaseName,
    secrets,
    logs,
    async restart() {
      if (mode === 'local-process') await stopLocalRuntime();
      await start(false);
    },
    stop: async () => {
      await stop();
      stopped = true;
    },
    async teardown(teardownOptions?: { failed?: boolean }) {
      await stop();
      stopped = true;
      const keep =
        teardownOptions?.failed === true && process.env.KEEP_EVIDENCE === '1';
      if (mode === 'docker') {
        await execFileAsync('docker', ['rm', '-f', containerName]).catch(
          () => undefined,
        );
      }
      if (keep) {
        // eslint-disable-next-line no-console
        console.error(
          `KEEP_EVIDENCE=1: keeping home ${home} and database ${databaseName}`,
        );
        return;
      }
      await dropRunDatabase(adminUrl, databaseName);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
