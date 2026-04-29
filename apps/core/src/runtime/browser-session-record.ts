import fs from 'fs';
import path from 'path';

export interface BrowserSessionRecord {
  pid: number;
  port: number;
  targetId?: string;
  startedAt: string;
  lastUsedAt: string;
  headless: boolean;
}

export interface PersistableBrowserSession {
  pid: number;
  port: number;
  targetId?: string;
  lastUsedAt: number;
  headless: boolean;
}

function getBrowserSessionRecordPath(profile: { dir: string }): string {
  return path.join(profile.dir, 'browser-session.json');
}

export function readBrowserSessionRecord(profile: {
  dir: string;
}): BrowserSessionRecord | null {
  const recordPath = getBrowserSessionRecordPath(profile);
  if (!fs.existsSync(recordPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as Record<
      string,
      unknown
    > | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN;
    const port = typeof parsed.port === 'number' ? parsed.port : NaN;
    const startedAt =
      typeof parsed.startedAt === 'string' ? parsed.startedAt : '';
    const lastUsedAt =
      typeof parsed.lastUsedAt === 'string' ? parsed.lastUsedAt : startedAt;
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65535 ||
      !startedAt
    ) {
      return null;
    }
    return {
      pid,
      port,
      startedAt,
      lastUsedAt,
      headless: parsed.headless === true,
      ...(typeof parsed.targetId === 'string'
        ? { targetId: parsed.targetId }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeBrowserSessionRecord(
  profile: { dir: string },
  session: PersistableBrowserSession,
): void {
  const recordPath = getBrowserSessionRecordPath(profile);
  const now = new Date(session.lastUsedAt).toISOString();
  const payload: BrowserSessionRecord = {
    pid: session.pid,
    port: session.port,
    ...(session.targetId ? { targetId: session.targetId } : {}),
    startedAt: readBrowserSessionRecord(profile)?.startedAt ?? now,
    lastUsedAt: now,
    headless: session.headless,
  };
  const tmpPath = `${recordPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(tmpPath, recordPath);
}

export function clearBrowserSessionRecord(profile: { dir: string }): void {
  try {
    fs.rmSync(getBrowserSessionRecordPath(profile), { force: true });
  } catch {
    // ignore
  }
}
