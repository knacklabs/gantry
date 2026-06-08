import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalSkillArtifactStore,
  hashSkillBundle,
} from '@core/adapters/artifacts/skills/local-skill-artifact-store.js';

describe('LocalSkillArtifactStore', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-skill-store-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('persists skill bundles as readable directory trees', async () => {
    const store = new LocalSkillArtifactStore(tempRoot);

    const stored = await store.putSkillArtifact({
      appId: 'app:one',
      skillId: 'skill:Uploaded One',
      skillName: 'Uploaded One',
      bundle: {
        assets: [
          {
            path: 'nested/context.md',
            content: Buffer.from('context\n', 'utf-8'),
          },
          {
            path: 'SKILL.md',
            contentType: 'text/markdown',
            content: Buffer.from('# Uploaded\n', 'utf-8'),
          },
        ],
      },
    });

    expect(stored.storageType).toBe('local-filesystem');
    expect(stored.storageRef).toBe('skills/Uploaded-One');
    expect(stored.storageRef.endsWith('.json')).toBe(false);
    expect(stored.sizeBytes).toBe(
      Buffer.byteLength('# Uploaded\n') + Buffer.byteLength('context\n'),
    );

    const artifactDir = resolveRef(stored.storageRef);
    expect(fs.statSync(artifactDir).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(artifactDir, 'SKILL.md'), 'utf-8')).toBe(
      '# Uploaded\n',
    );
    expect(
      fs.readFileSync(path.join(artifactDir, 'nested', 'context.md'), 'utf-8'),
    ).toBe('context\n');

    const loaded = await store.getSkillArtifact(stored.storageRef);
    expect(loaded.assets.map((asset) => asset.path)).toEqual([
      'nested/context.md',
      'SKILL.md',
    ]);
    expect(readAsset(loaded, 'SKILL.md')).toBe('# Uploaded\n');
    expect(readAsset(loaded, 'nested/context.md')).toBe('context\n');
    expect(
      loaded.assets.find((asset) => asset.path === 'SKILL.md'),
    ).toMatchObject({ contentType: 'text/markdown' });
    expect(hashSkillBundle(loaded)).toBe(stored.contentHash);
  });

  it('keeps content hashes deterministic over normalized paths and bytes', () => {
    const left = hashSkillBundle({
      assets: [
        {
          path: 'supporting/file.txt',
          contentType: 'text/plain',
          content: Buffer.from('file'),
        },
        { path: 'SKILL.md', content: Buffer.from('# Skill') },
      ],
    });
    const right = hashSkillBundle({
      assets: [
        {
          path: 'SKILL.md',
          contentType: 'application/octet-stream',
          content: Buffer.from('# Skill'),
        },
        { path: 'supporting/file.txt', content: Buffer.from('file') },
      ],
    });

    expect(left).toBe(right);
  });

  it('ignores hidden metadata when reconstructing artifacts', async () => {
    const store = new LocalSkillArtifactStore(tempRoot);
    const stored = await store.putSkillArtifact({
      appId: 'app:one',
      skillId: 'skill:metadata',
      skillName: 'metadata',
      bundle: {
        assets: [{ path: 'SKILL.md', content: Buffer.from('# Skill') }],
      },
    });
    const artifactDir = resolveRef(stored.storageRef);
    fs.writeFileSync(path.join(artifactDir, '.gantry-artifact.json'), '{}');
    fs.mkdirSync(path.join(artifactDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(artifactDir, '.git', 'config'), 'secret');

    const loaded = await store.getSkillArtifact(stored.storageRef);

    expect(loaded.assets.map((asset) => asset.path)).toEqual(['SKILL.md']);
    expect(readAsset(loaded, 'SKILL.md')).toBe('# Skill');
  });

  it('rejects traversal in storage refs and asset paths', async () => {
    const store = new LocalSkillArtifactStore(tempRoot);

    await expect(store.getSkillArtifact('../escape')).rejects.toThrow(
      'Invalid skill artifact storage ref',
    );
    await expect(
      store.putSkillArtifact({
        appId: 'app:one',
        skillId: 'skill:bad',
        skillName: 'bad',
        bundle: {
          assets: [
            { path: 'SKILL.md', content: Buffer.from('# Skill') },
            { path: 'nested/../secret.txt', content: Buffer.from('secret') },
          ],
        },
      }),
    ).rejects.toThrow('Invalid skill artifact path');
  });

  it('rejects symlinks during recursive reads', async () => {
    const store = new LocalSkillArtifactStore(tempRoot);
    const stored = await store.putSkillArtifact({
      appId: 'app:one',
      skillId: 'skill:symlink',
      skillName: 'symlink',
      bundle: {
        assets: [{ path: 'SKILL.md', content: Buffer.from('# Skill') }],
      },
    });
    const outsideFile = path.join(tempRoot, 'outside.txt');
    fs.writeFileSync(outsideFile, 'outside');
    try {
      fs.symlinkSync(
        outsideFile,
        path.join(resolveRef(stored.storageRef), 'x'),
      );
    } catch {
      return;
    }

    await expect(store.getSkillArtifact(stored.storageRef)).rejects.toThrow(
      'Skill artifact cannot contain symlinks',
    );
  });

  function resolveRef(storageRef: string): string {
    return path.join(tempRoot, ...storageRef.split('/'));
  }
});

function readAsset(
  bundle: Awaited<ReturnType<LocalSkillArtifactStore['getSkillArtifact']>>,
  assetPath: string,
): string {
  const asset = bundle.assets.find((item) => item.path === assetPath);
  if (!asset) throw new Error(`Missing asset: ${assetPath}`);
  return Buffer.from(asset.content).toString('utf-8');
}
