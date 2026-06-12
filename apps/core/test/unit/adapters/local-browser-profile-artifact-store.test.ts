import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactIntegrityError } from '@core/domain/ports/browser-profile-artifact-store.js';
import { LocalBrowserProfileArtifactStore } from '@core/adapters/artifacts/browser-profiles/local-browser-profile-artifact-store.js';

describe('LocalBrowserProfileArtifactStore', () => {
  let root: string;
  let target: string;
  let quarantine: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-bp-store-'));
    target = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-bp-target-'));
    quarantine = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-bp-q-'));
  });

  afterEach(async () => {
    for (const dir of [root, target, quarantine]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('puts then materializes a verified profile snapshot', async () => {
    const store = new LocalBrowserProfileArtifactStore(root);
    const stored = await store.putBrowserProfile({
      profileName: 'c-kai-abc123',
      files: [
        { path: 'Local State', content: Buffer.from('{"a":1}') },
        { path: 'Default/Cookies', content: Buffer.from('cookie-bytes') },
      ],
    });
    expect(stored.storageRef).toMatch(/^browser-profiles\/c-kai-abc123\//);
    expect(stored.contentHash).toMatch(/^sha256:/);
    expect(stored.sizeBytes).toBeGreaterThan(0);

    const activatedDir = path.join(target, 'user-data');
    const materialized = await store.materializeBrowserProfile({
      storageRef: stored.storageRef,
      expectedContentHash: stored.contentHash,
      targetDir: activatedDir,
      quarantineDir: quarantine,
    });
    expect(materialized.targetDir).toBe(activatedDir);
    expect(
      await fs.readFile(path.join(activatedDir, 'Default/Cookies'), 'utf-8'),
    ).toBe('cookie-bytes');
    expect(
      await fs.readFile(path.join(activatedDir, 'Local State'), 'utf-8'),
    ).toBe('{"a":1}');
  });

  it('preserves modes and relative symlinks', async () => {
    const store = new LocalBrowserProfileArtifactStore(root);
    const stored = await store.putBrowserProfile({
      profileName: 'gantry',
      files: [
        {
          path: 'Default/Cookies',
          kind: 'file',
          mode: 0o600,
          content: Buffer.from('cookies'),
        },
        {
          path: 'Default/alias',
          kind: 'symlink',
          linkTarget: 'Cookies',
          content: Buffer.alloc(0),
        },
      ],
    });
    const activatedDir = path.join(target, 'user-data');
    await store.materializeBrowserProfile({
      storageRef: stored.storageRef,
      expectedContentHash: stored.contentHash,
      targetDir: activatedDir,
      quarantineDir: quarantine,
    });
    const cookiePath = path.join(activatedDir, 'Default/Cookies');
    const aliasPath = path.join(activatedDir, 'Default/alias');
    expect((await fs.stat(cookiePath)).mode & 0o777).toBe(0o600);
    expect(await fs.readlink(aliasPath)).toBe('Cookies');
  });

  it('is an atomic swap: replaces a prior activated dir wholesale', async () => {
    const store = new LocalBrowserProfileArtifactStore(root);
    const activatedDir = path.join(target, 'user-data');
    // Pre-existing local state that must be wholly replaced (no stale leftovers).
    await fs.mkdir(activatedDir, { recursive: true });
    await fs.writeFile(path.join(activatedDir, 'STALE'), 'old');

    const stored = await store.putBrowserProfile({
      profileName: 'gantry',
      files: [{ path: 'Local State', content: Buffer.from('new') }],
    });
    await store.materializeBrowserProfile({
      storageRef: stored.storageRef,
      expectedContentHash: stored.contentHash,
      targetDir: activatedDir,
      quarantineDir: quarantine,
    });
    await expect(fs.access(path.join(activatedDir, 'STALE'))).rejects.toThrow();
    expect(
      await fs.readFile(path.join(activatedDir, 'Local State'), 'utf-8'),
    ).toBe('new');
  });

  it('quarantines and throws on a content-hash mismatch without activating', async () => {
    const store = new LocalBrowserProfileArtifactStore(root);
    const stored = await store.putBrowserProfile({
      profileName: 'gantry',
      files: [{ path: 'Local State', content: Buffer.from('{}') }],
    });
    const activatedDir = path.join(target, 'user-data');
    await expect(
      store.materializeBrowserProfile({
        storageRef: stored.storageRef,
        expectedContentHash: 'sha256:wrong',
        targetDir: activatedDir,
        quarantineDir: quarantine,
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(fs.access(activatedDir)).rejects.toThrow();
    const quarantined = await fs.readdir(quarantine);
    expect(quarantined.length).toBeGreaterThan(0);
  });
});
