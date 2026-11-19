import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PID_FILE = '.gantry-local-pids';
export function recordedPidsPath(home: string): string {
  return path.join(home, PID_FILE);
}
export function recordChildPid(home: string, pid: number): void {
  const file = recordedPidsPath(home);
  const pids = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : [];
  fs.writeFileSync(file, JSON.stringify([...new Set([...pids, pid])]), {
    mode: 0o600,
  });
}
export function signalLocalChild(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    process.kill(-pid, signal);
    return;
  }
  // Windows has no POSIX process groups; tsx also owns a worker process.
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (error) {
    try {
      process.kill(pid, 0);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
    throw error;
  }
}
export function stopRecordedChildren(home: string): void {
  const file = recordedPidsPath(home);
  if (!fs.existsSync(file)) return;
  const pids: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(pids)) throw new Error(`Invalid local PID file: ${file}`);
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    let command = '';
    try {
      command =
        process.platform === 'win32'
          ? execFileSync(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
              ],
              { encoding: 'utf8', windowsHide: true },
            )
          : execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
              encoding: 'utf8',
            });
    } catch {
      continue;
    }
    if (
      !/apps\/core\/src\/index\.ts|node_modules\/vite\/bin\/vite\.js/.test(
        command.replace(/\\/g, '/'),
      )
    )
      continue;
    try {
      signalLocalChild(pid, 'SIGTERM');
    } catch (error) {
      if (process.platform === 'win32') throw error;
      // The child may have exited between inspection and signalling.
    }
  }
  fs.unlinkSync(file);
}
