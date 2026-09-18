import { execFileSync } from 'node:child_process';
import net from 'node:net';

type DockerError = Error & { code?: string };

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
  return `Gantry local doctor\n  Home: ${home}\n  Node: ${process.versions.node}\n  Docker: ${docker}\n  Docker Compose: ${compose}\nReady: Docker prerequisites are available.`;
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
