import fs from 'fs';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import path from 'path';

import { logger } from '../infrastructure/logging/logger.js';
import { CHROME_PATH, DEFAULT_CHROME_ARGS } from './browser-config.js';
import { ensureBrowserTarget } from './browser-cdp-targets.js';
import type {
  BrowserProfileStatus,
  BrowserSessionStatus,
  LaunchBrowserOptions,
} from './browser-capability-types.js';
// prettier-ignore
import { acquireProfileLock, createProfile, getProfile, isValidBrowserProfileName, listProfiles, updateProfileMetadata, type BrowserProfileLock } from './browser-profiles.js';
// prettier-ignore
import { clearBrowserSessionRecord, readBrowserSessionRecord, writeBrowserSessionRecord } from './browser-session-record.js';
// prettier-ignore
import { resolveBrowserHeadless, resolveBrowserKeepAliveMs } from './browser-launch-options.js';
// prettier-ignore
import { hasPersistentBrowserState, inferAuthMarkers } from './browser-profile-state.js';
import { nowIso, nowMs as currentTimeMs } from '../shared/time/datetime.js';

export const DEFAULT_BROWSER_PROFILE_NAME = 'myclaw';
export type {
  BrowserProfileStatus,
  BrowserSessionStatus,
  LaunchBrowserOptions,
} from './browser-capability-types.js';

interface BrowserSession {
  profileName: string;
  port: number;
  targetId?: string;
  chromeProcess?: ChildProcess;
  pid: number;
  lock: BrowserProfileLock;
  lastUsedAt: number;
  keepAliveMs: number;
  keepAliveTimer: NodeJS.Timeout | null;
  headless: boolean;
}

const sessions = new Map<string, BrowserSession>();

function cleanupChromeSingletonArtifacts(userDataDir: string): void {
  for (const lockFile of [
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
    'DevToolsActivePort',
  ]) {
    try {
      fs.rmSync(`${userDataDir}/${lockFile}`, { force: true });
    } catch {
      // ignore
    }
  }
}

function findChrome(): string {
  if (CHROME_PATH) return CHROME_PATH;
  return process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome';
}

function resolveProfileName(profileName?: string): string {
  const normalized = (profileName || DEFAULT_BROWSER_PROFILE_NAME)
    .trim()
    .toLowerCase();
  if (!normalized) return DEFAULT_BROWSER_PROFILE_NAME;
  if (!isValidBrowserProfileName(normalized)) {
    throw new Error(
      'Invalid browser profile name. Use lowercase letters, digits, dot, underscore, or hyphen.',
    );
  }
  return normalized;
}

async function waitForCdpHttp(port: number, timeoutMs: number): Promise<void> {
  const startedAt = currentTimeMs();
  while (currentTimeMs() - startedAt < timeoutMs) {
    if (await isCdpHttpHealthy(port)) return;
    await sleepWithinDeadline(startedAt, timeoutMs, 500);
  }

  throw new Error(
    `Chrome CDP did not become healthy on port ${port} within ${timeoutMs}ms`,
  );
}

async function waitForDevToolsActivePort(
  userDataDir: string,
  timeoutMs: number,
): Promise<number> {
  const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
  const startedAt = currentTimeMs();
  while (currentTimeMs() - startedAt < timeoutMs) {
    try {
      const [portLine] = fs
        .readFileSync(activePortPath, 'utf-8')
        .split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return port;
      }
    } catch {
      // Chrome creates DevToolsActivePort asynchronously after process launch.
    }
    await sleepWithinDeadline(startedAt, timeoutMs, 100);
  }

  throw new Error(
    `Chrome did not publish DevToolsActivePort within ${timeoutMs}ms`,
  );
}

async function sleepWithinDeadline(
  startedAt: number,
  timeoutMs: number,
  maxSleepMs: number,
): Promise<void> {
  const elapsedMs = currentTimeMs() - startedAt;
  const remainingMs = Math.max(0, timeoutMs - elapsedMs);
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(1, Math.min(maxSleepMs, remainingMs))),
  );
}

function browserLaunchTimeoutMs(
  opts: LaunchBrowserOptions,
  maxTimeoutMs: number,
): number {
  const deadlineAtMs = opts.deadlineAtMs;
  if (typeof deadlineAtMs !== 'number' || !Number.isFinite(deadlineAtMs)) {
    return maxTimeoutMs;
  }
  const remainingMs = Math.trunc(deadlineAtMs - currentTimeMs());
  if (remainingMs <= 0) {
    throw new Error('Browser launch deadline exceeded');
  }
  return Math.min(maxTimeoutMs, remainingMs);
}

function isChromeAlive(session: BrowserSession): boolean {
  return isPidAlive(session.pid);
}

function isPidAlive(pid: number): boolean {
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

function isPidOwnedByBrowserProfile(
  pid: number,
  profile: { userDataDir: string },
): boolean {
  const commandLine = readPidCommandLine(pid);
  if (!commandLine) return false;
  const userDataDir = path.resolve(profile.userDataDir);
  return (
    commandLine.includes(`--user-data-dir=${userDataDir}`) ||
    commandLine.includes(`--user-data-dir="${userDataDir}"`) ||
    commandLine.includes(`--user-data-dir='${userDataDir}'`)
  );
}

async function isCdpHttpHealthy(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function isSessionHealthy(session: BrowserSession): Promise<boolean> {
  return isChromeAlive(session) && (await isCdpHttpHealthy(session.port));
}

async function closeUnhealthySession(
  profileName: string,
  session: BrowserSession,
): Promise<void> {
  logger.warn(
    { profileName, pid: session.pid, port: session.port },
    'Closing unhealthy browser session',
  );
  await closeBrowser(profileName).catch((err) => {
    logger.warn(
      { err, profileName, pid: session.pid, port: session.port },
      'Failed to close unhealthy browser session',
    );
  });
}

function touchSession(session: BrowserSession): void {
  const profile =
    getProfile(session.profileName) ?? createProfile(session.profileName);
  session.lastUsedAt = currentTimeMs();
  updateProfileMetadata(session.profileName, {
    last_used: new Date(session.lastUsedAt).toISOString(),
    cdp_port: session.port,
  });
  writeBrowserSessionRecord(profile, session);

  if (session.keepAliveTimer) clearTimeout(session.keepAliveTimer);
  session.keepAliveTimer = setTimeout(() => {
    closeBrowser(session.profileName).catch((err) => {
      logger.warn(
        { err, profileName: session.profileName },
        'Failed to auto-close idle browser session',
      );
    });
  }, session.keepAliveMs);
  session.keepAliveTimer.unref?.();
}

async function terminatePid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const startedAt = currentTimeMs();
  while (currentTimeMs() - startedAt < 2_000) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ignore
  }
}

async function recoverPersistedBrowserSession(input: {
  profileName: string;
  profile: { dir: string; userDataDir: string };
  lock: BrowserProfileLock;
  keepAliveMs: number;
}): Promise<BrowserSession | null> {
  const record = readBrowserSessionRecord(input.profile);
  if (!record) return null;

  if (!isPidAlive(record.pid)) {
    clearBrowserSessionRecord(input.profile);
    updateProfileMetadata(input.profileName, { cdp_port: undefined });
    return null;
  }

  if (!isPidOwnedByBrowserProfile(record.pid, input.profile)) {
    logger.warn(
      { profileName: input.profileName, pid: record.pid },
      'Ignoring persisted browser session whose PID is not owned by the profile',
    );
    clearBrowserSessionRecord(input.profile);
    updateProfileMetadata(input.profileName, { cdp_port: undefined });
    return null;
  }

  if (!(await isCdpHttpHealthy(record.port))) {
    logger.warn(
      { profileName: input.profileName, pid: record.pid, port: record.port },
      'Terminating browser process with unhealthy persisted CDP session',
    );
    await terminatePid(record.pid);
    clearBrowserSessionRecord(input.profile);
    updateProfileMetadata(input.profileName, { cdp_port: undefined });
    return null;
  }

  const session: BrowserSession = {
    profileName: input.profileName,
    port: record.port,
    targetId: record.targetId,
    pid: record.pid,
    lock: input.lock,
    lastUsedAt: Date.parse(record.lastUsedAt) || currentTimeMs(),
    keepAliveMs: input.keepAliveMs,
    keepAliveTimer: null,
    headless: record.headless,
  };
  sessions.set(input.profileName, session);
  touchSession(session);
  logger.info(
    { profileName: input.profileName, pid: record.pid, port: record.port },
    'Adopted persisted browser profile session',
  );
  return session;
}

function toStoppedStatus(
  profileName: string,
  error?: string,
): BrowserSessionStatus {
  return {
    profile: profileName,
    profileName,
    running: false,
    cdpReady: false,
    ...(error ? { error } : {}),
  };
}

function toRunningStatus(session: BrowserSession): BrowserSessionStatus {
  const idleExpiresAt = session.lastUsedAt + session.keepAliveMs;
  return {
    profile: session.profileName,
    profileName: session.profileName,
    running: true,
    cdpReady: true,
    cdpUrl: `http://127.0.0.1:${session.port}`,
    port: session.port,
    pid: session.pid,
    targetId: session.targetId,
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    headless: session.headless,
    keepAliveMs: session.keepAliveMs,
    idleExpiresAt: new Date(idleExpiresAt).toISOString(),
  };
}

export async function launchBrowser(
  opts: LaunchBrowserOptions = {},
): Promise<BrowserSessionStatus> {
  const profileName = resolveProfileName(opts.profileName);
  const keepAliveMs = resolveBrowserKeepAliveMs(opts.keepAliveMs);
  const existing = sessions.get(profileName);
  if (existing && (await isSessionHealthy(existing))) {
    existing.keepAliveMs = keepAliveMs;
    touchSession(existing);
    return toRunningStatus(existing);
  }

  if (existing) {
    await closeUnhealthySession(profileName, existing);
  }

  const profile = createProfile(profileName);
  const lock = await acquireProfileLock(profileName);
  let chromeProcess: ChildProcess | undefined;

  try {
    const recovered = await recoverPersistedBrowserSession({
      profileName,
      profile,
      lock,
      keepAliveMs,
    });
    if (recovered) return toRunningStatus(recovered);

    cleanupChromeSingletonArtifacts(profile.userDataDir);
    const headless = resolveBrowserHeadless(opts.headless);
    const chromeFlags = [
      ...DEFAULT_CHROME_ARGS,
      ...(headless ? ['--headless=new'] : []),
      `--user-data-dir=${profile.userDataDir}`,
      '--remote-debugging-port=0',
    ];

    chromeProcess = spawn(findChrome(), chromeFlags, {
      detached: true,
      stdio: 'ignore',
    });
    chromeProcess.unref();

    const pid = chromeProcess.pid;
    if (!pid || pid <= 0) {
      throw new Error('Failed to launch Chrome process');
    }

    const port = await waitForDevToolsActivePort(
      profile.userDataDir,
      browserLaunchTimeoutMs(opts, 10_000),
    );
    await waitForCdpHttp(port, browserLaunchTimeoutMs(opts, 10_000));
    const targetId = await ensureBrowserTarget(
      port,
      typeof opts.deadlineAtMs === 'number'
        ? { deadlineAtMs: opts.deadlineAtMs }
        : undefined,
    );

    const session: BrowserSession = {
      profileName,
      port,
      targetId,
      chromeProcess,
      pid,
      lock,
      lastUsedAt: currentTimeMs(),
      keepAliveMs,
      keepAliveTimer: null,
      headless,
    };

    sessions.set(profileName, session);
    touchSession(session);

    logger.info({ profileName, port }, 'Launched browser profile session');

    return toRunningStatus(session);
  } catch (err) {
    if (chromeProcess?.pid) {
      try {
        process.kill(chromeProcess.pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    lock.release();
    throw err;
  }
}

export async function ensureBrowserReady(
  opts: LaunchBrowserOptions = {},
): Promise<BrowserSessionStatus> {
  return launchBrowser(opts);
}

async function waitForProcessExit(
  session: BrowserSession,
  timeoutMs: number,
): Promise<boolean> {
  if (!isChromeAlive(session)) return true;
  const child = session.chromeProcess as
    | (ChildProcess & {
        once?: ChildProcess['once'];
      })
    | undefined;
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

  const startedAt = currentTimeMs();
  while (currentTimeMs() - startedAt < timeoutMs) {
    if (!isChromeAlive(session)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isChromeAlive(session);
}

export async function getBrowserStatus(
  profileName = DEFAULT_BROWSER_PROFILE_NAME,
): Promise<BrowserSessionStatus> {
  const normalized = resolveProfileName(profileName);
  const session = sessions.get(normalized);
  if (session) {
    if (await isSessionHealthy(session)) return toRunningStatus(session);
    return toStoppedStatus(normalized);
  }

  const profile = getProfile(normalized);
  if (!profile) return toStoppedStatus(normalized);
  const record = readBrowserSessionRecord(profile);
  if (
    !record ||
    !isPidAlive(record.pid) ||
    !isPidOwnedByBrowserProfile(record.pid, profile) ||
    !(await isCdpHttpHealthy(record.port))
  ) {
    return toStoppedStatus(normalized);
  }

  return {
    profile: normalized,
    profileName: normalized,
    running: true,
    cdpReady: true,
    cdpUrl: `http://127.0.0.1:${record.port}`,
    port: record.port,
    pid: record.pid,
    targetId: record.targetId,
    lastUsedAt: record.lastUsedAt,
    headless: record.headless,
  };
}

export function getKnownBrowserStatus(
  profileName = DEFAULT_BROWSER_PROFILE_NAME,
): BrowserSessionStatus {
  const normalized = resolveProfileName(profileName);
  const session = sessions.get(normalized);
  if (!session || !isChromeAlive(session)) return toStoppedStatus(normalized);
  return toRunningStatus(session);
}

export async function closeBrowser(
  profileName = DEFAULT_BROWSER_PROFILE_NAME,
): Promise<{ closed: boolean; reason?: string; elapsedMs?: number }> {
  const startedAt = currentTimeMs();
  const normalized = resolveProfileName(profileName);
  const session = sessions.get(normalized);
  if (!session) {
    const profile = createProfile(normalized);
    const lock = await acquireProfileLock(normalized);
    try {
      const record = readBrowserSessionRecord(profile);
      if (!record) {
        return {
          closed: true,
          reason: 'not_running',
          elapsedMs: currentTimeMs() - startedAt,
        };
      }
      const shouldTerminate =
        isPidAlive(record.pid) &&
        isPidOwnedByBrowserProfile(record.pid, profile);
      if (shouldTerminate) {
        await terminatePid(record.pid);
      } else {
        logger.warn(
          { profileName: normalized, pid: record.pid },
          'Clearing persisted browser session without terminating unverified PID',
        );
      }
      clearBrowserSessionRecord(profile);
      updateProfileMetadata(normalized, {
        last_used: nowIso(),
        cdp_port: undefined,
      });
      if (!shouldTerminate && isPidAlive(record.pid)) {
        return {
          closed: false,
          reason: 'pid_not_owned_by_browser_profile',
          elapsedMs: currentTimeMs() - startedAt,
        };
      }
      return {
        closed: true,
        reason: shouldTerminate ? 'terminated' : 'already_stopped',
        elapsedMs: currentTimeMs() - startedAt,
      };
    } finally {
      lock.release();
    }
  }

  if (session.keepAliveTimer) {
    clearTimeout(session.keepAliveTimer);
    session.keepAliveTimer = null;
  }

  try {
    process.kill(session.pid, 'SIGTERM');
  } catch {
    // ignore
  }

  let exited = await waitForProcessExit(session, 2_000);
  if (!exited) {
    try {
      process.kill(session.pid, 'SIGKILL');
    } catch {
      // ignore
    }
    exited = await waitForProcessExit(session, 1_000);
  }

  session.lock.release();
  sessions.delete(normalized);
  clearBrowserSessionRecord(createProfile(normalized));
  updateProfileMetadata(normalized, {
    last_used: nowIso(),
    cdp_port: undefined,
  });

  return {
    closed: exited,
    reason: exited ? 'terminated' : 'process_did_not_exit',
    elapsedMs: currentTimeMs() - startedAt,
  };
}

export async function closeAllBrowsers(): Promise<void> {
  const profileNames = [...sessions.keys()];
  for (const profileName of profileNames) {
    try {
      await closeBrowser(profileName);
    } catch (err) {
      logger.warn({ err, profileName }, 'Failed to close browser session');
    }
  }
}

export async function listBrowserProfiles(): Promise<BrowserProfileStatus[]> {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    profiles.push(createProfile(DEFAULT_BROWSER_PROFILE_NAME));
  }
  const statuses: BrowserProfileStatus[] = [];
  for (const profile of profiles) {
    const session = sessions.get(profile.name);
    const persisted = readBrowserSessionRecord(profile);
    const persistedRunning = Boolean(
      persisted &&
      isPidAlive(persisted.pid) &&
      isPidOwnedByBrowserProfile(persisted.pid, profile),
    );
    const running = session ? isChromeAlive(session) : persistedRunning;
    const cdpReady = session
      ? running && (await isCdpHttpHealthy(session.port))
      : Boolean(
          persistedRunning &&
          persisted &&
          (await isCdpHttpHealthy(persisted.port)),
        );
    const authMarkers = new Set([
      ...(profile.metadata.auth_markers || []),
      ...inferAuthMarkers(profile),
    ]);
    statuses.push({
      name: profile.name,
      created_at: profile.metadata.created_at,
      last_used: profile.metadata.last_used,
      cdp_port: profile.metadata.cdp_port,
      auth_markers: [...authMarkers].sort(),
      has_state: hasPersistentBrowserState(profile),
      running,
      cdpReady,
    });
  }
  return statuses;
}
