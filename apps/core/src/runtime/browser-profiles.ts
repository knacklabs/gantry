import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { DATA_DIR } from '../config/index.js';

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_LOCK_STALE_MS = 10 * 60 * 1000;
const PROFILE_LOCK_HEARTBEAT_MS = 30_000;
const PROFILE_AUTH_SCAN_MAX_BYTES = 10 * 1024 * 1024;

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

export interface BrowserProfileStateSummary {
  hasState: boolean;
  authMarkers: string[];
}

export interface BrowserProfileLock {
  name: string;
  lockPath: string;
  release: () => void;
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

const AUTH_MARKER_DOMAINS = [
  'linkedin.com',
  'x.com',
  'twitter.com',
  'google.com',
  'github.com',
] as const;

function chromeCookieDbPaths(userDataDir: string): string[] {
  return [
    path.join(userDataDir, 'Default', 'Cookies'),
    path.join(userDataDir, 'Default', 'Network', 'Cookies'),
    path.join(userDataDir, 'Profile 1', 'Cookies'),
    path.join(userDataDir, 'Profile 1', 'Network', 'Cookies'),
  ];
}

function hasNonEmptyPath(targetPath: string): boolean {
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return stat.size > 0;
    if (!stat.isDirectory()) return false;
    return fs.readdirSync(targetPath).length > 0;
  } catch {
    return false;
  }
}

function readSmallFileLowercase(targetPath: string): string {
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isFile() || stat.size <= 0) return '';
    const fd = fs.openSync(targetPath, 'r');
    try {
      const length = Math.min(stat.size, PROFILE_AUTH_SCAN_MAX_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, 0);
      return buffer.toString('latin1').toLowerCase();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function detectChromeAuthMarkers(userDataDir: string): string[] {
  const detected = new Set<string>();
  for (const cookiePath of chromeCookieDbPaths(userDataDir)) {
    const body = readSmallFileLowercase(cookiePath);
    if (!body) continue;
    for (const domain of AUTH_MARKER_DOMAINS) {
      if (body.includes(domain)) detected.add(domain);
    }
  }
  return [...detected].sort();
}

export function summarizeBrowserProfileState(
  profile: Pick<BrowserProfile, 'userDataDir' | 'statePath' | 'metadata'>,
): BrowserProfileStateSummary {
  const metadataMarkers = profile.metadata.auth_markers || [];
  const detectedMarkers = detectChromeAuthMarkers(profile.userDataDir);
  const markerSet = new Set([...metadataMarkers, ...detectedMarkers]);
  const hasChromeState =
    chromeCookieDbPaths(profile.userDataDir).some(hasNonEmptyPath) ||
    hasNonEmptyPath(
      path.join(profile.userDataDir, 'Default', 'Local Storage', 'leveldb'),
    ) ||
    hasNonEmptyPath(
      path.join(profile.userDataDir, 'Default', 'Session Storage'),
    );

  return {
    hasState: fs.existsSync(profile.statePath) || hasChromeState,
    authMarkers: [...markerSet].sort(),
  };
}

function readMetadata(name: string): BrowserProfileMetadata {
  const profileDir = getProfileDir(name);
  const metadataPath = getProfileMetadataPath(name);
  const now = new Date().toISOString();
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

export function getProfileUserDataDir(name: string): string {
  const profileDir = getProfileDir(name);
  const userDataDir = path.join(profileDir, 'user-data');
  ensureDir(userDataDir);
  return userDataDir;
}

export function getProfileStatePath(name: string): string {
  const profileDir = getProfileDir(name);
  ensureDir(profileDir);
  return path.join(profileDir, 'state.json');
}

export function createProfile(name: string): BrowserProfile {
  const normalized = assertProfileName(name);
  const profileDir = getProfileDir(normalized);
  const userDataDir = path.join(profileDir, 'user-data');

  ensureDir(getBrowserProfilesRoot());
  ensureDir(profileDir);
  ensureDir(userDataDir);

  const now = new Date().toISOString();
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

export function deleteProfile(name: string): void {
  const normalized = assertProfileName(name);
  const profileDir = getProfileDir(normalized);
  fs.rmSync(profileDir, { recursive: true, force: true });
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
  if (!merged.created_at) merged.created_at = new Date().toISOString();
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

export function readProfileState(name: string): string {
  const statePath = getProfileStatePath(name);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Profile state not found for ${name}`);
  }
  return fs.readFileSync(statePath, 'utf-8');
}

export function writeProfileState(name: string, stateJson: string): void {
  const normalized = assertProfileName(name);
  const parsed = JSON.parse(stateJson) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Profile state JSON must be an object');
  }

  const statePath = getProfileStatePath(normalized);
  const tmpPath = `${statePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2));
  fs.renameSync(tmpPath, statePath);
  updateProfileMetadata(normalized, { last_used: new Date().toISOString() });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLockFile(lockPath: string): { pid?: number; token?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const pid =
      typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)
        ? Math.round(parsed.pid)
        : undefined;
    const token = typeof parsed.token === 'string' ? parsed.token : undefined;
    return { pid, token };
  } catch {
    return {};
  }
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireProfileLock(
  name: string,
  timeoutMs = 5000,
): Promise<BrowserProfileLock> {
  const normalized = assertProfileName(name);
  const profileDir = getProfileDir(normalized);
  ensureDir(profileDir);
  const lockPath = path.join(profileDir, 'profile.lock');
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const token = randomUUID();
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          token,
          created_at: new Date().toISOString(),
        }),
      );
      fs.closeSync(fd);

      let released = false;
      const heartbeat = setInterval(() => {
        try {
          const current = readLockFile(lockPath);
          if (current.token === token) {
            const now = new Date();
            fs.utimesSync(lockPath, now, now);
          }
        } catch {
          // Best effort heartbeat; release/token checks still protect takeover.
        }
      }, PROFILE_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return {
        name: normalized,
        lockPath,
        release: () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          try {
            const current = readLockFile(lockPath);
            if (current.token === token) {
              fs.rmSync(lockPath, { force: true });
            }
          } catch {
            // ignore
          }
        },
      };
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: string }).code)
          : '';
      if (code !== 'EEXIST') throw err;

      try {
        const stat = fs.statSync(lockPath);
        const existing = readLockFile(lockPath);
        if (
          !isPidAlive(existing.pid) ||
          (existing.pid === undefined &&
            Date.now() - stat.mtimeMs > PROFILE_LOCK_STALE_MS)
        ) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // Best effort; retry.
      }
      await sleep(100);
    }
  }

  throw new Error(`Timed out acquiring profile lock for ${normalized}`);
}
