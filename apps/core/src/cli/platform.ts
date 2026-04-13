import { execFileSync } from 'child_process';
import os from 'os';

export type HostPlatform = 'macos' | 'linux' | 'unknown';

export function detectPlatform(): HostPlatform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

export function commandExists(command: string): boolean {
  try {
    execFileSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function tryExec(
  command: string,
  args: string[],
): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: String(stdout || ''), stderr: '' };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || ''),
    };
  }
}

export function getNodeVersion(): string {
  return process.version.replace(/^v/, '');
}

export function getNodeMajorVersion(): number {
  const raw = getNodeVersion().split('.')[0];
  const major = Number(raw);
  return Number.isFinite(major) ? major : 0;
}

export function hasDocker(): boolean {
  return commandExists('docker');
}

export function isDockerRunning(): boolean {
  if (!hasDocker()) return false;
  return tryExec('docker', ['info']).ok;
}

export function hasAppleContainer(): boolean {
  return commandExists('container');
}

export function hasSystemdUser(): boolean {
  if (detectPlatform() !== 'linux') return false;
  if (!commandExists('systemctl')) return false;
  return tryExec('systemctl', ['--user', 'show-environment']).ok;
}
