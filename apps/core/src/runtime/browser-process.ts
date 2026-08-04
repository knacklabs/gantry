import { execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidCommandLine(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      const command = raw.replace(/\0/g, ' ').trim();
      if (command) return command;
    } catch {
      // Fall back to ps below for non-/proc environments and tests.
    }
  }
  try {
    return execFileSync(
      '/bin/ps',
      ['-p', String(pid), '-ww', '-o', 'command='],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return undefined;
  }
}

function hasHeadlessChromeFlag(commandLine: string): boolean {
  return /(?:^|\s)--headless(?:=|\s|$)/.test(commandLine);
}

export function browserProcessProfileState(
  pid: number,
  profile: { userDataDir: string },
): { owned: boolean; headless: boolean } {
  const commandLine = readPidCommandLine(pid);
  if (!commandLine) return { owned: false, headless: false };
  const userDataDir = path.resolve(profile.userDataDir);
  return {
    owned:
      commandLine.includes(`--user-data-dir=${userDataDir}`) ||
      commandLine.includes(`--user-data-dir="${userDataDir}"`) ||
      commandLine.includes(`--user-data-dir='${userDataDir}'`),
    headless: hasHeadlessChromeFlag(commandLine),
  };
}

export function isPidOwnedByBrowserProfile(
  pid: number,
  profile: { userDataDir: string },
): boolean {
  return browserProcessProfileState(pid, profile).owned;
}

export function isPidOwnedVisibleBrowserProfile(
  pid: number,
  profile: { userDataDir: string },
): boolean {
  const state = browserProcessProfileState(pid, profile);
  return state.owned && !state.headless;
}

async function waitForBrowserProcessExit(
  session: { pid: number; chromeProcess?: ChildProcess },
  timeoutMs: number,
): Promise<boolean> {
  if (!isPidAlive(session.pid)) return true;
  const child = session.chromeProcess;
  if (typeof child?.once === 'function') {
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', done);
      child.once('close', done);
    });
    if (exited) return true;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(session.pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidAlive(session.pid);
}

export async function stopBrowserProcess(session: {
  pid: number;
  chromeProcess?: ChildProcess;
}): Promise<boolean> {
  try {
    process.kill(session.pid, 'SIGTERM');
  } catch {
    // The process is already stopped.
  }
  let exited = await waitForBrowserProcessExit(session, 2_000);
  if (!exited) {
    try {
      process.kill(session.pid, 'SIGKILL');
    } catch {
      // The process stopped between the probe and kill.
    }
    exited = await waitForBrowserProcessExit(session, 1_000);
  }
  return exited;
}
