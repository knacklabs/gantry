import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { styleText } from 'node:util';

type DockerError = Error & { code?: string };

function localStyle(format: 'bold' | 'cyan' | 'dim', value: string): string {
  return process.stdout.isTTY ? styleText(format, value) : value;
}

function dockerUnavailable(error: unknown): Error {
  if ((error as DockerError).code === 'ENOENT')
    return new Error(
      'Docker is not installed. Gantry local development runs Postgres in Docker, not Homebrew Postgres. Install Docker Desktop, start it, then rerun the command.',
    );
  return new Error(
    'Docker is installed but its daemon is not running. Start Docker Desktop and wait for “Engine running”, then rerun the command.',
    { cause: error },
  );
}

export function localDockerPrerequisites(): {
  docker: string;
  compose: string;
} {
  let docker: string;
  try {
    docker = execFileSync(
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      {
        encoding: 'utf8',
      },
    ).trim();
  } catch (error) {
    throw dockerUnavailable(error);
  }
  try {
    return {
      docker,
      compose: execFileSync('docker', ['compose', 'version', '--short'], {
        encoding: 'utf8',
      }).trim(),
    };
  } catch (error) {
    throw new Error(
      'Docker Compose v2 is unavailable. Update Docker Desktop, then rerun the command.',
      { cause: error },
    );
  }
}

export function formatLocalDoctor(home: string): string {
  const { docker, compose } = localDockerPrerequisites();
  return `${localStyle('bold', 'Gantry local doctor')}\n  ${localStyle('dim', 'Home:')} ${home}\n  ${localStyle('dim', 'Node:')} ${process.versions.node}\n  ${localStyle('dim', 'Docker:')} ${docker}\n  ${localStyle('dim', 'Docker Compose:')} ${compose}\n${localStyle('cyan', 'Ready: Docker prerequisites are available.')}`;
}

export function formatLocalCommand(
  command: string,
  home: string,
  database: string,
  origin: string,
): string {
  return `${localStyle('bold', `Gantry local ${command}`)}\n  ${localStyle('dim', 'Home:')} ${home}\n  ${localStyle('dim', 'Database:')} ${database}\n  ${localStyle('dim', 'UI:')} ${origin}`;
}

export function formatLocalReady(command: string, origin: string): string {
  return `\n${localStyle('bold', `Gantry local ${command} ready`)}\n\n${localStyle('bold', localStyle('cyan', `Gantry Web UI: ${origin}/ui/`))}\n\n${localStyle('dim', 'Ctrl-C stops core and Vite; Postgres stays running.')}`;
}

export async function freeLocalPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export function localUrlAtPort(url: string, port: number): string {
  const target = new URL(url);
  target.port = String(port);
  return target.toString();
}

export function localHostPortConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { stdout, stderr } = error as Error & {
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };
  return /port is already allocated|address already in use|bind:.*failed/i.test(
    [error.message, stdout, stderr]
      .map((value) => String(value || ''))
      .join('\n'),
  );
}

async function localPortAvailable(
  host: string,
  port: number,
): Promise<boolean> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) =>
      server
        .listen(port, host.replace(/^\[|\]$/g, ''), resolve)
        .once('error', reject),
    );
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function resolveLocalUiOrigin(
  env: NodeJS.ProcessEnv,
  origin: string,
  canonicalOrigin?: string,
): Promise<string> {
  const requested = new URL(origin);
  if (await localPortAvailable(requested.hostname, Number(requested.port)))
    return origin;
  if (canonicalOrigin)
    throw new Error(
      `Port ${requested.port} is in use and authentication.canonical_origin requires ${canonicalOrigin}. Free port ${requested.port}, or set authentication.canonical_origin in ${env.GANTRY_HOME}/settings.yaml and GANTRY_CONTROL_PORT to the same available port.`,
    );
  const fallbackPort = await freeLocalPort();
  env.GANTRY_CONTROL_PORT = String(fallbackPort);
  const fallback = new URL(origin);
  fallback.port = String(fallbackPort);
  console.warn(
    `Port ${requested.port} is in use; using ${fallback.origin}/ui/ instead.`,
  );
  return fallback.origin;
}
