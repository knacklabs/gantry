import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config/index.js';
import type { RuntimeLeasePort } from '../domain/ports/runtime-lease.js';
import { nowIso, nowMs as currentTimeMs } from '../shared/time/datetime.js';

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_LOCK_RETRY_MS = 50;
const PROFILE_LOCK_TIMEOUT_MS = 30_000;

export interface BrowserProfileMetadata {
  created_at: string;
  last_used: string;
  cdp_port?: number;
  chrome_pid?: number;
  auth_markers?: string[];
}

export interface BrowserProfile {
  name: string;
  dir: string;
  userDataDir: string;
  statePath: string;
  metadata: BrowserProfileMetadata;
}

export interface BrowserProfileLock {
  name: string;
  lockPath?: string;
  release: () => void | Promise<void>;
}

export function getBrowserProfilesRoot(): string {
  return path.join(DATA_DIR, 'browser-profiles');
}

export function isValidBrowserProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name.trim());
}

function assertProfileName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!isValidBrowserProfileName(normalized)) {
    throw new Error(
      'Invalid profile name. Use lowercase letters, digits, dot, underscore, or hyphen (1-64 chars).',
    );
  }
  return normalized;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function getProfileDir(name: string): string {
  return path.join(getBrowserProfilesRoot(), assertProfileName(name));
}

function getProfileMetadataPath(name: string): string {
  return path.join(getProfileDir(name), 'profile.json');
}

function readMetadata(name: string): BrowserProfileMetadata {
  const profileDir = getProfileDir(name);
  const metadataPath = getProfileMetadataPath(name);
  const now = nowIso();
  const fallback: BrowserProfileMetadata = {
    created_at: now,
    last_used: now,
    auth_markers: [],
  };

  if (!fs.existsSync(metadataPath)) return fallback;

  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Record<
      string,
      unknown
    > | null;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const createdAt =
      typeof parsed.created_at === 'string' ? parsed.created_at : now;
    const lastUsed =
      typeof parsed.last_used === 'string' ? parsed.last_used : createdAt;
    const cdpPort =
      typeof parsed.cdp_port === 'number' && Number.isFinite(parsed.cdp_port)
        ? Math.round(parsed.cdp_port)
        : undefined;
    const chromePid =
      typeof parsed.chrome_pid === 'number' &&
      Number.isFinite(parsed.chrome_pid)
        ? Math.round(parsed.chrome_pid)
        : undefined;
    const authMarkers = Array.isArray(parsed.auth_markers)
      ? parsed.auth_markers
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 100)
      : [];
    return {
      created_at: createdAt,
      last_used: lastUsed,
      ...(cdpPort !== undefined ? { cdp_port: cdpPort } : {}),
      ...(chromePid !== undefined ? { chrome_pid: chromePid } : {}),
      auth_markers: authMarkers,
    };
  } catch {
    // Reset malformed metadata to defaults.
    ensureDir(profileDir);
    return fallback;
  }
}

function writeMetadata(name: string, metadata: BrowserProfileMetadata): void {
  const metadataPath = getProfileMetadataPath(name);
  const tmpPath = `${metadataPath}.tmp`;
  const payload: Record<string, unknown> = {
    created_at: metadata.created_at,
    last_used: metadata.last_used,
    auth_markers: metadata.auth_markers || [],
  };
  if (metadata.cdp_port !== undefined) {
    payload.cdp_port = metadata.cdp_port;
  }
  if (metadata.chrome_pid !== undefined) {
    payload.chrome_pid = metadata.chrome_pid;
  }
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, metadataPath);
}

export function createProfile(name: string): BrowserProfile {
  const normalized = assertProfileName(name);
  const profileDir = getProfileDir(normalized);
  const userDataDir = path.join(profileDir, 'user-data');

  ensureDir(getBrowserProfilesRoot());
  ensureDir(profileDir);
  ensureDir(userDataDir);

  const now = nowIso();
  const existing = readMetadata(normalized);
  const metadata: BrowserProfileMetadata = {
    ...existing,
    created_at: existing.created_at || now,
    last_used: now,
  };
  writeMetadata(normalized, metadata);

  return {
    name: normalized,
    dir: profileDir,
    userDataDir,
    statePath: path.join(profileDir, 'state.json'),
    metadata,
  };
}

export function getProfile(name: string): BrowserProfile | null {
  const normalized = assertProfileName(name);
  const profileDir = getProfileDir(normalized);
  if (!fs.existsSync(profileDir)) return null;

  const userDataDir = path.join(profileDir, 'user-data');
  ensureDir(userDataDir);
  return {
    name: normalized,
    dir: profileDir,
    userDataDir,
    statePath: path.join(profileDir, 'state.json'),
    metadata: readMetadata(normalized),
  };
}

export function listProfiles(): BrowserProfile[] {
  const root = getBrowserProfilesRoot();
  if (!fs.existsSync(root)) return [];

  const dirs = fs
    .readdirSync(root)
    .filter((entry) => {
      if (!isValidBrowserProfileName(entry)) return false;
      try {
        return fs.statSync(path.join(root, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();

  return dirs
    .map((name) => getProfile(name))
    .filter((profile): profile is BrowserProfile => profile !== null);
}

export function updateProfileMetadata(
  name: string,
  patch: Partial<BrowserProfileMetadata>,
): BrowserProfileMetadata {
  const normalized = assertProfileName(name);
  const existing = readMetadata(normalized);
  const merged: BrowserProfileMetadata = {
    ...existing,
    ...patch,
    auth_markers: patch.auth_markers || existing.auth_markers || [],
  };
  if (!merged.created_at) merged.created_at = nowIso();
  if (!merged.last_used) merged.last_used = merged.created_at;
  if (patch.cdp_port === undefined && 'cdp_port' in patch) {
    delete (merged as { cdp_port?: number }).cdp_port;
  }
  if (patch.chrome_pid === undefined && 'chrome_pid' in patch) {
    delete (merged as { chrome_pid?: number }).chrome_pid;
  }
  writeMetadata(normalized, merged);
  return merged;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireProfileLock(
  name: string,
  leases: RuntimeLeasePort,
  timeoutMs = PROFILE_LOCK_TIMEOUT_MS,
): Promise<BrowserProfileLock> {
  const normalized = assertProfileName(name);
  const leaseKey = `browser-profile:${normalized}`;
  const boundedTimeoutMs = Math.min(
    PROFILE_LOCK_TIMEOUT_MS,
    Math.max(0, timeoutMs),
  );
  const started = currentTimeMs();

  while (true) {
    const lease = await leases.tryAcquire(leaseKey);
    if (lease) {
      let releasePromise: Promise<void> | undefined;
      return {
        name: normalized,
        release: () => (releasePromise ??= lease.release()),
      };
    }

    const remainingMs = boundedTimeoutMs - (currentTimeMs() - started);
    if (remainingMs <= 0) break;
    await sleep(Math.min(PROFILE_LOCK_RETRY_MS, remainingMs));
  }

  throw new Error(`Timed out acquiring profile lock for ${normalized}`);
}
