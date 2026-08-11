import type {
  SkillArtifactBundle,
  SkillArtifactStore,
  StoredSkillArtifact,
} from '../../../domain/ports/skill-artifact-store.js';

/**
 * Remote-authoritative skill artifact store with a local cache.
 *
 * Fleet deployments can replace their local runtime home on every task start,
 * but selected skill metadata is durable. The object store must therefore be
 * the source of truth once configured; local disk is only a warm cache for
 * faster access.
 */
export class RemoteFirstSkillArtifactStore implements SkillArtifactStore {
  constructor(
    private readonly authority: SkillArtifactStore,
    private readonly cache: SkillArtifactStore,
  ) {}

  async putSkillArtifact(input: {
    appId: string;
    skillId: string;
    skillName: string;
    bundle: SkillArtifactBundle;
  }): Promise<StoredSkillArtifact> {
    const stored = await this.authority.putSkillArtifact(input);
    await this.tryWarmCache(input);
    return stored;
  }

  async getSkillArtifact(storageRef: string): Promise<SkillArtifactBundle> {
    const bundle = await this.authority.getSkillArtifact(storageRef);
    await this.tryWarmCacheFromStorageRef(storageRef, bundle);
    return bundle;
  }

  private async tryWarmCache(input: {
    appId: string;
    skillId: string;
    skillName: string;
    bundle: SkillArtifactBundle;
  }): Promise<void> {
    try {
      await this.cache.putSkillArtifact(input);
    } catch {
      // Local cache warming must never block the remote-authoritative write/read.
    }
  }

  private async tryWarmCacheFromStorageRef(
    storageRef: string,
    bundle: SkillArtifactBundle,
  ): Promise<void> {
    try {
      const [apps, appId, skills, skillId, contentHash, ...extra] = storageRef
        .replace(/\\/g, '/')
        .split('/');
      if (
        apps !== 'apps' ||
        !appId ||
        skills !== 'skills' ||
        !skillId ||
        !contentHash ||
        extra.length > 0
      ) {
        return;
      }
      await this.cache.putSkillArtifact({
        appId: decodeURIComponent(appId),
        skillId: decodeURIComponent(skillId),
        skillName: storageRef,
        bundle,
      });
    } catch {
      // Local cache warming must never block the remote-authoritative read.
    }
  }
}
