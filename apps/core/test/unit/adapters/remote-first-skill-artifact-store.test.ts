import { describe, expect, it } from 'vitest';

import { RemoteFirstSkillArtifactStore } from '@core/adapters/artifacts/skills/remote-first-skill-artifact-store.js';
import {
  type SkillArtifactBundle,
  type SkillArtifactStore,
  type StoredSkillArtifact,
} from '@core/domain/ports/skill-artifact-store.js';
import { hashSkillBundle } from '@core/shared/skill-artifact-helpers.js';

const bundle: SkillArtifactBundle = {
  assets: [{ path: 'SKILL.md', content: Buffer.from('# Skill') }],
};

class MemorySkillArtifactStore implements SkillArtifactStore {
  readonly puts: Array<{
    appId: string;
    skillId: string;
    skillName: string;
    bundle: SkillArtifactBundle;
  }> = [];
  readonly bundles = new Map<string, SkillArtifactBundle>();

  constructor(
    private readonly storageType: StoredSkillArtifact['storageType'],
    private readonly failGet = false,
    private readonly failPut = false,
  ) {}

  async putSkillArtifact(input: {
    appId: string;
    skillId: string;
    skillName: string;
    bundle: SkillArtifactBundle;
  }): Promise<StoredSkillArtifact> {
    if (this.failPut) throw new Error('put failed');
    this.puts.push(input);
    const contentHash = hashSkillBundle(input.bundle);
    const storageRef = `apps/${encodeStorageSegment(input.appId)}/skills/${encodeStorageSegment(input.skillId)}/${encodeStorageSegment(contentHash)}`;
    this.bundles.set(storageRef, input.bundle);
    return {
      storageType: this.storageType,
      storageRef,
      contentHash,
      sizeBytes: input.bundle.assets.reduce(
        (sum, asset) => sum + asset.content.byteLength,
        0,
      ),
    };
  }

  async getSkillArtifact(storageRef: string): Promise<SkillArtifactBundle> {
    if (this.failGet) throw new Error('get failed');
    const found = this.bundles.get(storageRef);
    if (!found) throw new Error(`missing ${storageRef}`);
    return found;
  }
}

describe('RemoteFirstSkillArtifactStore', () => {
  it('writes to the remote authority and warms local cache without changing returned metadata', async () => {
    const remote = new MemorySkillArtifactStore('object-store');
    const cache = new MemorySkillArtifactStore('local-filesystem');
    const store = new RemoteFirstSkillArtifactStore(remote, cache);

    const stored = await store.putSkillArtifact({
      appId: 'default',
      skillId: 'skill:ats',
      skillName: 'ATS_Skills',
      bundle,
    });

    expect(stored.storageType).toBe('object-store');
    expect(stored.storageRef).toBe(
      `apps/default/skills/skill%3Aats/${encodeStorageSegment(hashSkillBundle(bundle))}`,
    );
    expect(remote.puts).toHaveLength(1);
    expect(cache.puts).toHaveLength(1);
  });

  it('reads from S3 authority first and rehydrates the local cache after redeploy', async () => {
    const remote = new MemorySkillArtifactStore('object-store');
    const cache = new MemorySkillArtifactStore('local-filesystem');
    const stored = await remote.putSkillArtifact({
      appId: 'default',
      skillId: 'skill:ats',
      skillName: 'ATS_Skills',
      bundle,
    });
    const store = new RemoteFirstSkillArtifactStore(remote, cache);

    const loaded = await store.getSkillArtifact(stored.storageRef);

    expect(loaded).toBe(bundle);
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0]).toMatchObject({
      appId: 'default',
      skillName: stored.storageRef,
      skillId: 'skill:ats',
    });
    await expect(cache.getSkillArtifact(stored.storageRef)).resolves.toBe(
      bundle,
    );
  });

  it('falls back to local cache for legacy local-only artifacts during first sync', async () => {
    const remote = new MemorySkillArtifactStore('object-store');
    const cache = new MemorySkillArtifactStore('local-filesystem');
    cache.bundles.set('skills/Legacy', bundle);
    const store = new RemoteFirstSkillArtifactStore(remote, cache);

    await expect(store.getSkillArtifact('skills/Legacy')).resolves.toBe(bundle);
  });

  it('does not fall back to stale local cache when the remote authority is unavailable', async () => {
    const remote = new MemorySkillArtifactStore('object-store', true);
    const cache = new MemorySkillArtifactStore('local-filesystem');
    const stored = await cache.putSkillArtifact({
      appId: 'default',
      skillId: 'skill:stale',
      skillName: 'Stale',
      bundle,
    });
    const store = new RemoteFirstSkillArtifactStore(remote, cache);

    await expect(store.getSkillArtifact(stored.storageRef)).rejects.toThrow(
      'get failed',
    );
  });

  it('does not fail a remote read when local cache warming fails', async () => {
    const remote = new MemorySkillArtifactStore('object-store');
    const cache = new MemorySkillArtifactStore('local-filesystem', false, true);
    const stored = await remote.putSkillArtifact({
      appId: 'default',
      skillId: 'skill:remote',
      skillName: 'Remote',
      bundle,
    });
    const store = new RemoteFirstSkillArtifactStore(remote, cache);

    await expect(store.getSkillArtifact(stored.storageRef)).resolves.toBe(
      bundle,
    );
  });
});

function encodeStorageSegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, '%2E');
}
