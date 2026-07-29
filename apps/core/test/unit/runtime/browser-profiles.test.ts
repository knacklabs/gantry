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
    vi.useRealTimers();
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

  it('acquires the normalized profile lease and releases it', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    const release = vi.fn(async () => {});
    const tryAcquire = vi.fn(async () => ({
      isValid: () => true,
      release,
    }));

    const lock = await mod.acquireProfileLock(' Lease-Test ', { tryAcquire });

    expect(tryAcquire).toHaveBeenCalledOnce();
    expect(tryAcquire).toHaveBeenCalledWith('browser-profile:lease-test');
    expect(lock.name).toBe('lease-test');
    await lock.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it('registers lease loss before resolving and exposes invalid ownership', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    let loseLease: ((err: Error) => void) | undefined;
    const registrationOrder: string[] = [];
    const onLost = vi.fn((handler: (err: Error) => void) => {
      registrationOrder.push('registered');
      loseLease = handler;
    });
    const release = vi.fn(async () => {});
    const acquired = Promise.resolve({
      isValid: () => true,
      onLost,
      release,
    });
    const acquiring = mod.acquireProfileLock('loss-observed', {
      tryAcquire: () => {
        void acquired.then(() =>
          queueMicrotask(() => registrationOrder.push('after-acquire')),
        );
        return acquired;
      },
    });

    const lock = await acquiring;
    expect(registrationOrder).toEqual(['registered', 'after-acquire']);
    expect(onLost).toHaveBeenCalledOnce();
    const observedLoss = vi.fn();
    lock.onLost(observedLoss);

    const loss = new Error('lease connection lost');
    loseLease?.(loss);

    expect(lock.isValid()).toBe(false);
    expect(observedLoss).toHaveBeenCalledWith(loss);
    await Promise.all([lock.release(), lock.release()]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('retries a held lease and fails closed after the bounded wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    const tryAcquire = vi.fn(async () => undefined);
    const acquiring = mod.acquireProfileLock('held-lease', { tryAcquire }, 125);
    const rejection = expect(acquiring).rejects.toThrow(
      /Timed out acquiring profile lock/,
    );

    await vi.runAllTimersAsync();
    await rejection;
    expect(tryAcquire.mock.calls.length).toBeGreaterThan(1);
  });

  it('releases an acquired lease at most once', async () => {
    const root = makeTmpRoot(roots);
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: root,
    }));

    const mod = await import('@core/runtime/browser-profiles.js');
    const release = vi.fn(async () => {});
    const lock = await mod.acquireProfileLock('idempotent-release', {
      tryAcquire: async () => ({ isValid: () => true, release }),
    });

    await Promise.all([lock.release(), lock.release()]);

    expect(release).toHaveBeenCalledOnce();
  });
});
