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
 * faster access and legacy recovery while an old local artifact is being synced.
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
    try {
      const bundle = await this.authority.getSkillArtifact(storageRef);
      await this.tryWarmCacheFromStorageRef(storageRef, bundle);
      return bundle;
    } catch (authorityError) {
      if (!isMissingArtifactError(authorityError)) {
        throw authorityError;
      }
      try {
        return await this.cache.getSkillArtifact(storageRef);
      } catch (cacheError) {
        throw new Error(
          `Skill artifact unavailable from remote authority or local cache: ${storageRef}. ` +
            `Remote: ${errorMessage(authorityError)}; local: ${errorMessage(cacheError)}`,
          { cause: authorityError },
        );
      }
    }
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

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isMissingArtifactError(value: unknown): boolean {
  const message = errorMessage(value);
  return (
    message.includes('Skill artifact must contain SKILL.md') ||
    message.includes('NoSuchKey') ||
    message.includes('not found') ||
    message.includes('missing ')
  );
}
