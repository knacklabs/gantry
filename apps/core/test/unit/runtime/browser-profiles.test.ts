import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeTmpRoot(roots: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-browser-'));
  roots.push(root);
  return root;
}

describe('browser-profiles', () => {
  const roots: string[] = [];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates, lists, and reads browser profiles', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');

    const created = mod.createProfile('main-profile');
    expect(created.name).toBe('main-profile');
    expect(fs.existsSync(created.userDataDir)).toBe(true);

    const listed = mod.listProfiles();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('main-profile');

    const found = mod.getProfile('main-profile');
    expect(found?.metadata.created_at).toBeTruthy();
    expect(found?.metadata.last_used).toBeTruthy();
  });

  it('acquires and releases locks', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    mod.createProfile('lock-test');

    const lock = await mod.acquireProfileLock('lock-test', 1000);
    expect(fs.existsSync(lock.lockPath)).toBe(true);

    await expect(mod.acquireProfileLock('lock-test', 250)).rejects.toThrow(
      /Timed out acquiring profile lock/,
    );

    lock.release();
    expect(fs.existsSync(lock.lockPath)).toBe(false);

    const second = await mod.acquireProfileLock('lock-test', 1000);
    second.release();
  });

  it('does not steal a stale-mtime lock while the recorded pid is alive', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    mod.createProfile('live-lock');
    const lock = await mod.acquireProfileLock('live-lock', 1000);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(lock.lockPath, old, old);

    await expect(mod.acquireProfileLock('live-lock', 250)).rejects.toThrow(
      /Timed out acquiring profile lock/,
    );
    lock.release();
  });

  it('only releases the lock file owned by the same token', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    mod.createProfile('token-lock');
    const first = await mod.acquireProfileLock('token-lock', 1000);
    fs.rmSync(first.lockPath, { force: true });
    const second = await mod.acquireProfileLock('token-lock', 1000);

    first.release();
    expect(fs.existsSync(second.lockPath)).toBe(true);
    second.release();
  });

  it('still reclaims a genuinely stale lock', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    const profile = mod.createProfile('stale-lock');
    const lockPath = path.join(profile.dir, 'profile.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 0, token: 'stale-token' }),
    );

    const lock = await mod.acquireProfileLock('stale-lock', 1000);
    expect(fs.readFileSync(lockPath, 'utf-8')).not.toContain('stale-token');
    lock.release();
  });

  it('does not remove a fresh lock that replaces the observed stale lock', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    const profile = mod.createProfile('replaced-stale-lock');
    const lockPath = path.join(profile.dir, 'profile.lock');
    const staleLock = JSON.stringify({ pid: 0, token: 'stale-token' });
    const freshLock = JSON.stringify({
      pid: process.pid,
      token: 'fresh-token',
    });
    fs.writeFileSync(lockPath, staleLock);

    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(
      (filePath, ...args: any[]) => {
        const observed = originalReadFileSync(filePath, ...(args as [any]));
        fs.rmSync(lockPath);
        fs.writeFileSync(lockPath, freshLock);
        return observed;
      },
    );

    await expect(
      mod.acquireProfileLock('replaced-stale-lock', 250),
    ).rejects.toThrow(/Timed out acquiring profile lock/);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(freshLock);
  });
});
