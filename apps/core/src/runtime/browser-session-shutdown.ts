import { logger } from '../infrastructure/logging/logger.js';
import { nowIso } from '../shared/time/datetime.js';
import { stopBrowserProcess } from './browser-process.js';
import {
  createProfile,
  updateProfileMetadata,
  type BrowserProfileLock,
} from './browser-profiles.js';
import { clearBrowserSessionRecord } from './browser-session-record.js';

type BrowserProcessHandle = Parameters<
  typeof stopBrowserProcess
>[0]['chromeProcess'];

export interface BrowserSessionShutdownTarget {
  profileName: string;
  pid: number;
  chromeProcess?: BrowserProcessHandle;
  keepAliveTimer: NodeJS.Timeout | null;
  lock: BrowserProfileLock;
}

interface BrowserProcessTarget {
  profileName: string;
  pid: number;
  chromeProcess?: BrowserProcessHandle;
}

interface LeaseLossTeardown {
  session: BrowserProcessTarget;
  outcome: Promise<{ exited: boolean; error?: unknown }>;
}

const leaseLossTeardowns = new Map<string, LeaseLossTeardown>();

export function hasBrowserLeaseLossTeardown(profileName: string): boolean {
  return leaseLossTeardowns.has(profileName);
}

export function trackBrowserLeaseLossTeardown(
  session: BrowserProcessTarget,
  teardown: Promise<boolean>,
): LeaseLossTeardown {
  const existing = leaseLossTeardowns.get(session.profileName);
  if (existing) return existing;
  const tracked: LeaseLossTeardown = {
    session,
    outcome: teardown.then(
      (exited) => {
        if (exited !== true) {
          logger.error(
            { profileName: session.profileName, pid: session.pid },
            'Browser process did not exit after profile lease loss',
          );
        }
        return { exited: exited === true };
      },
      (error) => {
        logger.error(
          { err: error, profileName: session.profileName, pid: session.pid },
          'Failed to stop browser process after profile lease loss',
        );
        return { exited: false, error };
      },
    ),
  };
  leaseLossTeardowns.set(session.profileName, tracked);
  tracked.outcome.then(({ exited }) => {
    if (exited && leaseLossTeardowns.get(session.profileName) === tracked) {
      leaseLossTeardowns.delete(session.profileName);
    }
  });
  return tracked;
}

export async function ensureLeaseLossProcessStopped(
  session: BrowserProcessTarget,
): Promise<boolean> {
  const tracked =
    leaseLossTeardowns.get(session.profileName) ??
    trackBrowserLeaseLossTeardown(session, stopBrowserProcess(session));
  const { exited } = await tracked.outcome;
  if (exited && leaseLossTeardowns.get(session.profileName) === tracked) {
    leaseLossTeardowns.delete(session.profileName);
  }
  return exited;
}

export async function finishBrowserLeaseLossTeardown(
  profileName: string,
): Promise<boolean | undefined> {
  const tracked = leaseLossTeardowns.get(profileName);
  if (!tracked) return undefined;
  const initial = await tracked.outcome;
  let exited = initial.exited;
  let teardownError = initial.error;
  if (!exited) {
    try {
      exited = await stopBrowserProcess(tracked.session);
    } catch (err) {
      teardownError ??= err;
    }
  }
  if (!exited && teardownError) throw teardownError;
  if (exited && leaseLossTeardowns.get(profileName) === tracked) {
    leaseLossTeardowns.delete(profileName);
  }
  return exited;
}

export async function shutdownBrowserSession(
  session: BrowserSessionShutdownTarget,
  options: { ownershipLost?: boolean } = {},
): Promise<boolean> {
  if (session.keepAliveTimer) clearTimeout(session.keepAliveTimer);
  session.keepAliveTimer = null;
  const exited = await stopBrowserProcess(session);
  if (options.ownershipLost || !session.lock.isValid()) return exited;
  try {
    clearBrowserSessionRecord(createProfile(session.profileName));
    updateProfileMetadata(session.profileName, {
      last_used: nowIso(),
      cdp_port: undefined,
    });
  } finally {
    await session.lock.release();
  }
  return exited;
}
