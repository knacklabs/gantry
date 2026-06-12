import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactIntegrityError } from '@core/domain/ports/toolchain-artifact-store.js';
import { LocalToolchainArtifactStore } from '@core/adapters/artifacts/toolchains/local-toolchain-artifact-store.js';

describe('LocalToolchainArtifactStore', () => {
  let root: string;
  let target: string;
  let quarantine: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-tc-store-'));
    target = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-tc-target-'));
    quarantine = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-tc-q-'));
  });

  afterEach(async () => {
    for (const dir of [root, target, quarantine]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('puts then materializes a verified toolchain artifact', async () => {
    const store = new LocalToolchainArtifactStore(root);
    const stored = await store.putToolchainArtifact({
      appId: 'app-1',
      manifestHash: 'sha256:m1',
      files: [
        { path: 'package.json', content: Buffer.from('{}') },
        {
          path: 'node_modules/left-pad/index.js',
          content: Buffer.from('module.exports = 1;'),
        },
      ],
    });
    expect(stored.storageRef).toBe('toolchains/m1');
    expect(stored.contentHash).toMatch(/^sha256:/);

    const activatedDir = path.join(target, 'active');
    const materialized = await store.materializeToolchainArtifact({
      storageRef: stored.storageRef,
      expectedContentHash: stored.contentHash,
      targetDir: activatedDir,
      quarantineDir: quarantine,
    });
    expect(materialized.targetDir).toBe(activatedDir);
    const packed = await fs.readFile(
      path.join(activatedDir, 'node_modules/left-pad/index.js'),
      'utf-8',
    );
    expect(packed).toBe('module.exports = 1;');
  });

  it('preserves executable modes and relative symlinks', async () => {
    const store = new LocalToolchainArtifactStore(root);
    const stored = await store.putToolchainArtifact({
      appId: 'app-1',
      manifestHash: 'sha256:m-symlink',
      files: [
        {
          path: 'node_modules/tool/bin/cli.js',
          kind: 'file',
          mode: 0o755,
          content: Buffer.from('#!/usr/bin/env node\n'),
        },
        {
          path: 'node_modules/.bin/tool',
          kind: 'symlink',
          linkTarget: '../tool/bin/cli.js',
          content: Buffer.alloc(0),
        },
      ],
    });
    const activatedDir = path.join(target, 'active');

    await store.materializeToolchainArtifact({
      storageRef: stored.storageRef,
      expectedContentHash: stored.contentHash,
      targetDir: activatedDir,
      quarantineDir: quarantine,
    });

    const binPath = path.join(activatedDir, 'node_modules/tool/bin/cli.js');
    const symlinkPath = path.join(activatedDir, 'node_modules/.bin/tool');
    expect((await fs.stat(binPath)).mode & 0o777).toBe(0o755);
    expect(await fs.readlink(symlinkPath)).toBe('../tool/bin/cli.js');
  });

  it('quarantines and throws on a content-hash mismatch without activating', async () => {
    const store = new LocalToolchainArtifactStore(root);
    const stored = await store.putToolchainArtifact({
      appId: 'app-1',
      manifestHash: 'sha256:m2',
      files: [{ path: 'package.json', content: Buffer.from('{}') }],
    });
    const activatedDir = path.join(target, 'active');
    await expect(
      store.materializeToolchainArtifact({
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
