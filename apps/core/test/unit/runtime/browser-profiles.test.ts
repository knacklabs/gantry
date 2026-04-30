import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeTmpRoot(roots: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-browser-'));
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

  it('writes and loads profile state', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    mod.createProfile('x');

    const state = {
      cookies: [{ name: 'sid', value: 'abc' }],
      origins: [{ origin: 'https://x.com', localStorage: [] }],
    };
    mod.writeProfileState('x', JSON.stringify(state));

    const loaded = JSON.parse(mod.readProfileState('x')) as {
      cookies: Array<{ name: string; value: string }>;
    };
    expect(loaded.cookies[0].name).toBe('sid');
    expect(loaded.cookies[0].value).toBe('abc');
  });

  it('detects Chrome cookie-backed profile state and auth markers', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    const profile = mod.createProfile('cookies');
    const cookieDir = path.join(profile.userDataDir, 'Default', 'Network');
    fs.mkdirSync(cookieDir, { recursive: true });
    fs.writeFileSync(
      path.join(cookieDir, 'Cookies'),
      'SQLite format 3\0.linkedin.com\0li_at\0',
    );

    expect(mod.summarizeBrowserProfileState(profile)).toEqual({
      hasState: true,
      authMarkers: ['linkedin.com'],
    });
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
});
