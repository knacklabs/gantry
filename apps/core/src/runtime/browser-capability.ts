import fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { createServer } from 'net';

import { logger } from '../infrastructure/logging/logger.js';
import { DEFAULT_CHROME_ARGS } from './browser-config.js';
import { resolveChromeExecutablePath } from '../shared/chrome-executable.js';
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
import { resolveBrowserKeepAliveMs } from './browser-launch-options.js';
import { nowIso, nowMs as currentTimeMs } from '../shared/time/datetime.js';
import {
  browserProfileState,
  persistedBrowserStatus,
  runningBrowserStatus,
  stoppedBrowserStatus,
} from './browser-status.js';
import {
  browserProcessProfileState,
  isPidAlive,
  isPidOwnedByBrowserProfile,
  isPidOwnedVisibleBrowserProfile,
} from './browser-process.js';
import {
  browserProfileNeedsRestore,
  restoreBrowserProfileBeforeLaunch,
} from './browser-profile-sync.js';

export const DEFAULT_BROWSER_PROFILE_NAME = 'gantry';
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
const pendingLaunches = new Map<string, Promise<BrowserSessionStatus>>();

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
  return resolveChromeExecutablePath();
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

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error) => reject(err);
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      resolve();
    });
  });
  const address = server.address();
  const port =
    address && typeof address === 'object' ? address.port : undefined;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65_535
  ) {
    throw new Error('Failed to reserve Chrome CDP port');
  }
  return port;
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

async function closePersistedSessionBeforeRestore(
  profileName: string,
  profile: { dir: string; userDataDir: string },
): Promise<void> {
  const record = readBrowserSessionRecord(profile);
  if (!record) return;
  const processState = browserProcessProfileState(record.pid, profile);
  if (isPidAlive(record.pid) && processState.owned) {
    await terminatePid(record.pid);
  }
  clearBrowserSessionRecord(profile);
  updateProfileMetadata(profileName, { cdp_port: undefined });
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

  const processState = browserProcessProfileState(record.pid, input.profile);
  if (!processState.owned) {
    logger.warn(
      { profileName: input.profileName, pid: record.pid },
      'Ignoring persisted browser session whose PID is not owned by the profile',
    );
    clearBrowserSessionRecord(input.profile);
    updateProfileMetadata(input.profileName, { cdp_port: undefined });
    return null;
  }

  if (processState.headless || record.headless === true) {
    logger.warn(
      { profileName: input.profileName, pid: record.pid },
      'Terminating non-visible persisted browser session',
    );
    await terminatePid(record.pid);
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
    headless: false,
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
  return stoppedBrowserStatus({
    profileName,
    profile: getProfile(profileName),
    chromeExecutable: findChrome(),
    error,
  });
}

function toRunningStatus(session: BrowserSession): BrowserSessionStatus {
  const profile =
    getProfile(session.profileName) ?? createProfile(session.profileName);
  return runningBrowserStatus({
    session,
    profile,
    chromeExecutable: findChrome(),
  });
}

export async function launchBrowser(
  opts: LaunchBrowserOptions = {},
): Promise<BrowserSessionStatus> {
  const profileName = resolveProfileName(opts.profileName);
  const keepAliveMs = resolveBrowserKeepAliveMs(opts.keepAliveMs);
  const pending = pendingLaunches.get(profileName);
  if (pending) return await waitForPendingLaunch(pending, opts);
  const launch = launchBrowserInner(profileName, keepAliveMs, {
    ...opts,
    deadlineAtMs: undefined,
  });
  pendingLaunches.set(profileName, launch);
  launch.then(
    () => {
      if (pendingLaunches.get(profileName) === launch) {
        pendingLaunches.delete(profileName);
      }
    },
    () => {
      if (pendingLaunches.get(profileName) === launch) {
        pendingLaunches.delete(profileName);
      }
    },
  );
  return await waitForPendingLaunch(launch, opts);
}

async function launchBrowserInner(
  profileName: string,
  keepAliveMs: number,
  opts: LaunchBrowserOptions,
): Promise<BrowserSessionStatus> {
  const profile = createProfile(profileName);
  let existing = sessions.get(profileName);
  if (existing && (await isSessionHealthy(existing))) {
    if (await browserProfileNeedsRestore(profileName, profile.dir)) {
      logger.info(
        { profileName, pid: existing.pid, port: existing.port },
        'Closing browser session before restoring newer shared profile snapshot',
      );
      await closeBrowser(profileName);
      existing = undefined;
    } else {
      existing.keepAliveMs = keepAliveMs;
      touchSession(existing);
      return toRunningStatus(existing);
    }
  }

  if (existing) {
    await closeUnhealthySession(profileName, existing);
  }

  const lock = await acquireProfileLock(profileName);
  let chromeProcess: ChildProcess | undefined;

  try {
    const needsRestore = await browserProfileNeedsRestore(
      profileName,
      profile.dir,
    );
    if (needsRestore) {
      await closePersistedSessionBeforeRestore(profileName, profile);
    } else {
      const recovered = await recoverPersistedBrowserSession({
        profileName,
        profile,
        lock,
        keepAliveMs,
      });
      if (recovered) return toRunningStatus(recovered);
    }

    // No owned Chrome is running (adoption above returned null): restore a newer
    // cross-worker snapshot before launch. No-op off-fleet.
    await restoreBrowserProfileBeforeLaunch(profileName, profile);

    cleanupChromeSingletonArtifacts(profile.userDataDir);
    const debuggingPort = await reserveLoopbackPort();
    const chromeFlags = [
      ...DEFAULT_CHROME_ARGS,
      `--user-data-dir=${profile.userDataDir}`,
      `--remote-debugging-port=${debuggingPort}`,
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

    await waitForCdpHttp(debuggingPort, browserLaunchTimeoutMs(opts, 10_000));
    const targetId = await ensureBrowserTarget(
      debuggingPort,
      typeof opts.deadlineAtMs === 'number'
        ? { deadlineAtMs: opts.deadlineAtMs }
        : undefined,
    );

    const session: BrowserSession = {
      profileName,
      port: debuggingPort,
      targetId,
      chromeProcess,
      pid,
      lock,
      lastUsedAt: currentTimeMs(),
      keepAliveMs,
      keepAliveTimer: null,
      headless: false,
    };

    sessions.set(profileName, session);
    touchSession(session);

    logger.info(
      { profileName, port: debuggingPort },
      'Launched browser profile session',
    );

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

async function waitForPendingLaunch(
  launch: Promise<BrowserSessionStatus>,
  opts: LaunchBrowserOptions,
): Promise<BrowserSessionStatus> {
  const deadlineAtMs = opts.deadlineAtMs;
  if (typeof deadlineAtMs !== 'number' || !Number.isFinite(deadlineAtMs)) {
    return await launch;
  }
  const remainingMs = Math.trunc(deadlineAtMs - currentTimeMs());
  if (remainingMs <= 0) throw new Error('Browser launch deadline exceeded');
  return await new Promise<BrowserSessionStatus>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Browser launch deadline exceeded')),
      remainingMs,
    );
    timer.unref?.();
    launch.then(
      (status) => {
        clearTimeout(timer);
        resolve(status);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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
    !isPidOwnedVisibleBrowserProfile(record.pid, profile) ||
    !(await isCdpHttpHealthy(record.port))
  ) {
    return toStoppedStatus(normalized);
  }
  return persistedBrowserStatus({
    profileName: normalized,
    profile,
    record,
    chromeExecutable: findChrome(),
  });
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
    const persistedState = persisted
      ? browserProcessProfileState(persisted.pid, profile)
      : undefined;
    const persistedRunning = Boolean(
      persisted &&
      isPidAlive(persisted.pid) &&
      persistedState?.owned &&
      !persistedState.headless &&
      persisted.headless !== true,
    );
    const running = session ? isChromeAlive(session) : persistedRunning;
    const cdpReady = session
      ? running && (await isCdpHttpHealthy(session.port))
      : Boolean(
          persistedRunning &&
          persisted &&
          (await isCdpHttpHealthy(persisted.port)),
        );
    const state = browserProfileState(profile);
    const headless =
      session?.headless ?? persistedState?.headless ?? persisted?.headless;
    statuses.push({
      name: profile.name,
      created_at: profile.metadata.created_at,
      last_used: profile.metadata.last_used,
      cdp_port: profile.metadata.cdp_port,
      auth_markers: state.authMarkers,
      has_state: state.hasState,
      authMarkers: state.authMarkers,
      hasState: state.hasState,
      profilePersistent: true,
      userDataDir: profile.userDataDir,
      chromeExecutable: findChrome(),
      headless,
      running,
      cdpReady,
    });
  }
  return statuses;
}
