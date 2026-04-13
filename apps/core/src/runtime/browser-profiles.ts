import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../core/config.js';

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_LOCK_STALE_MS = 10 * 60 * 1000;

export interface BrowserProfileMetadata {
  created_at: string;
  last_used: string;
  cdp_port?: number;
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
    const authMarkers = Array.isArray(parsed.auth_markers)
      ? parsed.auth_markers
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 100)
      : [];
    return {
      created_at: createdAt,
      last_used: lastUsed,
      ...(cdpPort !== undefined ? { cdp_port: cdpPort } : {}),
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
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
        }),
      );
      fs.closeSync(fd);

      let released = false;
      return {
        name: normalized,
        lockPath,
        release: () => {
          if (released) return;
          released = true;
          try {
            fs.rmSync(lockPath, { force: true });
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
        if (Date.now() - stat.mtimeMs > PROFILE_LOCK_STALE_MS) {
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
