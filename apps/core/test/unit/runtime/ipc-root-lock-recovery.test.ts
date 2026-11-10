import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { recoverStaleIpcRootLock } from '@core/runtime/ipc-filesystem.js';

const dirs: string[] = [];

function writeLock(startedAt: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-ipc-lock-'));
  dirs.push(dir);
  const lockPath = path.join(dir, '.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt }));
  return lockPath;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('recoverStaleIpcRootLock with a reused pid', () => {
  it('recovers a lock with our pid that was written before this process started', () => {
    const lockPath = writeLock(new Date(Date.now() - 3_600_000).toISOString());
    const result = recoverStaleIpcRootLock(lockPath);
    expect(result.recovered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('keeps a lock this process wrote itself', () => {
    const lockPath = writeLock(new Date().toISOString());
    const result = recoverStaleIpcRootLock(lockPath);
    expect(result).toMatchObject({ recovered: false, recoveryReason: 'same_process' });
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
