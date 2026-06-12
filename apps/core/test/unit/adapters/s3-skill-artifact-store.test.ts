import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { S3SkillArtifactStore } from '@core/adapters/artifacts/skills/s3-skill-artifact-store.js';
import { hashSkillBundle } from '@core/adapters/artifacts/skills/local-skill-artifact-store.js';
import { ArtifactIntegrityError } from '@core/domain/ports/skill-artifact-store.js';

interface StoredObject {
  body: Buffer;
  metadata: Record<string, string>;
  contentType?: string;
}

class FakeS3Client {
  readonly objects = new Map<string, StoredObject>();

  // Mirrors the AWS SDK v3 command-dispatch contract the driver depends on.
  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const { Bucket, Key, Body, Metadata, ContentType } = command.input;
      this.objects.set(`${Bucket}/${Key}`, {
        body: Buffer.from(Body as Uint8Array),
        metadata: (Metadata ?? {}) as Record<string, string>,
        contentType: ContentType,
      });
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      const { Bucket, Prefix } = command.input;
      const prefix = `${Bucket}/${Prefix ?? ''}`;
      const contents = [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => ({ Key: key.slice(`${Bucket}/`.length) }));
      return { Contents: contents, IsTruncated: false };
    }
    if (command instanceof GetObjectCommand) {
      const { Bucket, Key } = command.input;
      const stored = this.objects.get(`${Bucket}/${Key}`);
      if (!stored) throw new Error(`NoSuchKey: ${Key}`);
      return {
        Body: {
          transformToByteArray: async () => new Uint8Array(stored.body),
        },
        Metadata: stored.metadata,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      const { Bucket, Delete } = command.input;
      for (const entry of Delete?.Objects ?? []) {
        if (entry.Key) this.objects.delete(`${Bucket}/${entry.Key}`);
      }
      return {};
    }
    throw new Error(
      `Unsupported command: ${(command as object).constructor.name}`,
    );
  }

  asClient(): S3Client {
    return this as unknown as S3Client;
  }
}

const BUCKET = 'gantry-artifacts';

function makeStore(): { store: S3SkillArtifactStore; fake: FakeS3Client } {
  const fake = new FakeS3Client();
  return { store: new S3SkillArtifactStore(fake.asClient(), BUCKET), fake };
}

const skillBundle = {
  assets: [
    { path: 'nested/context.md', content: Buffer.from('context\n', 'utf-8') },
    {
      path: 'SKILL.md',
      contentType: 'text/markdown',
      content: Buffer.from('# Uploaded\n', 'utf-8'),
    },
  ],
};

describe('S3SkillArtifactStore', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-s3-store-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('mirrors the local skills/<name>/ layout under the key prefix', async () => {
    const { store, fake } = makeStore();
    const stored = await store.putSkillArtifact({
      appId: 'app:one',
      skillId: 'skill:Uploaded One',
      skillName: 'Uploaded One',
      bundle: skillBundle,
    });

    expect(stored.storageType).toBe('object-store');
    expect(stored.storageRef).toBe('skills/Uploaded-One');
    expect(stored.contentHash).toBe(hashSkillBundle(skillBundle));

    const keys = [...fake.objects.keys()].map((k) =>
      k.slice(`${BUCKET}/`.length),
    );
    expect(keys).toContain('skills/Uploaded-One/SKILL.md');
    expect(keys).toContain('skills/Uploaded-One/nested/context.md');
    // sha256 is written as object metadata (defense in depth).
    const asset = fake.objects.get(`${BUCKET}/skills/Uploaded-One/SKILL.md`);
    expect(asset?.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips a bundle through get and excludes hidden metadata', async () => {
    const { store } = makeStore();
    const stored = await store.putSkillArtifact({
      appId: 'app:one',
      skillId: 'skill:roundtrip',
      skillName: 'roundtrip',
      bundle: skillBundle,
    });
    const loaded = await store.getSkillArtifact(stored.storageRef);
    expect(loaded.assets.map((a) => a.path)).toEqual([
      'nested/context.md',
      'SKILL.md',
    ]);
    // The .gantry-artifact.json manifest must not surface as an asset.
    expect(
      loaded.assets.some((a) => a.path.includes('.gantry-artifact.json')),
    ).toBe(false);
    expect(hashSkillBundle(loaded)).toBe(stored.contentHash);
  });

  it('replaces on update without versioning (stale assets are purged)', async () => {
    const { store, fake } = makeStore();
    await store.putSkillArtifact({
      appId: 'app:one',
      skillId: 'skill:replace',
      skillName: 'replace',
      bundle: {
        assets: [
          { path: 'SKILL.md', content: Buffer.from('# v1') },
          { path: 'old.md', content: Buffer.from('stale') },
        ],
      },
    });
    await store.putSkillArtifact({
      appId: 'app:one',
      skillId: 'skill:replace',
      skillName: 'replace',
      bundle: { assets: [{ path: 'SKILL.md', content: Buffer.from('# v2') }] },
    });
    const keys = [...fake.objects.keys()].map((k) =>
      k.slice(`${BUCKET}/`.length),
    );
    expect(keys).not.toContain('skills/replace/old.md');
    const loaded = await store.getSkillArtifact('skills/replace');
    expect(loaded.assets.map((a) => a.path)).toEqual(['SKILL.md']);
    expect(Buffer.from(loaded.assets[0]!.content).toString()).toBe('# v2');
  });

  it('materializes to disk with an atomic rename when the hash verifies', async () => {
    const { store } = makeStore();
    const stored = await store.putSkillArtifact({
      appId: 'app:one',
      skillId: 'skill:materialize',
      skillName: 'materialize',
      bundle: skillBundle,
    });
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    const targetDir = path.join(tempRoot, 'active', 'materialize');
    const quarantineDir = path.join(tempRoot, 'quarantine');
    const result = await store.materializeSkillArtifact({
      storageRef: stored.storageRef,
      expectedContentHash: stored.contentHash,
      targetDir,
      quarantineDir,
    });

    expect(result.targetDir).toBe(path.resolve(targetDir));
    expect(result.contentHash).toBe(stored.contentHash);
    // Atomic activation: the final placement is a rename, not a piecemeal write.
    expect(
      renameSpy.mock.calls.some(([, to]) => to === path.resolve(targetDir)),
    ).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf-8')).toBe(
      '# Uploaded\n',
    );
    expect(fs.existsSync(quarantineDir)).toBe(false);
    renameSpy.mockRestore();
  });

  it('quarantines and throws a typed error on sha256 mismatch without activating', async () => {
    const { store } = makeStore();
    const stored = await store.putSkillArtifact({
      appId: 'app:one',
      skillId: 'skill:tampered',
      skillName: 'tampered',
      bundle: skillBundle,
    });
    const targetDir = path.join(tempRoot, 'active', 'tampered');
    const quarantineDir = path.join(tempRoot, 'quarantine');

    const caught: unknown = await store
      .materializeSkillArtifact({
        storageRef: stored.storageRef,
        expectedContentHash: 'sha256:deadbeef',
        targetDir,
        quarantineDir,
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(caught).toBeInstanceOf(ArtifactIntegrityError);
    const error = caught as ArtifactIntegrityError;
    expect(error.storageRef).toBe('skills/tampered');
    expect(error.expectedContentHash).toBe('sha256:deadbeef');
    expect(error.actualContentHash).toBe(stored.contentHash);
    // Not activated.
    expect(fs.existsSync(targetDir)).toBe(false);
    // Quarantined copy present and auditable.
    expect(fs.existsSync(error.quarantinePath)).toBe(true);
    expect(
      fs.readFileSync(path.join(error.quarantinePath, 'SKILL.md'), 'utf-8'),
    ).toBe('# Uploaded\n');

    // A second integrity failure for the same storageRef (same millisecond is
    // typical here) must land in a distinct path so the first forensic copy
    // is never overwritten.
    const secondCaught: unknown = await store
      .materializeSkillArtifact({
        storageRef: stored.storageRef,
        expectedContentHash: 'sha256:deadbeef',
        targetDir,
        quarantineDir,
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(secondCaught).toBeInstanceOf(ArtifactIntegrityError);
    const secondError = secondCaught as ArtifactIntegrityError;
    expect(secondError.quarantinePath).not.toBe(error.quarantinePath);
    expect(fs.existsSync(error.quarantinePath)).toBe(true);
    expect(fs.existsSync(secondError.quarantinePath)).toBe(true);
  });
});
