import path from 'node:path';
/**
 * Remote-authoritative skill artifact store with a local cache.
 *
 * Fleet deployments can replace their local runtime home on every task start,
 * but selected skill metadata is durable. The object store must therefore be
 * the source of truth once configured; local disk is only a warm cache for
 * faster access and legacy recovery while an old local artifact is being synced.
 */
export class RemoteFirstSkillArtifactStore {
    authority;
    cache;
    constructor(authority, cache) {
        this.authority = authority;
        this.cache = cache;
    }
    async putSkillArtifact(input) {
        const stored = await this.authority.putSkillArtifact(input);
        await this.tryWarmCache(input);
        return stored;
    }
    async getSkillArtifact(storageRef) {
        try {
            const bundle = await this.authority.getSkillArtifact(storageRef);
            await this.tryWarmCache({
                appId: 'cache',
                skillId: `cache:${storageRef}`,
                skillName: skillNameFromStorageRef(storageRef),
                bundle,
            });
            return bundle;
        }
        catch (authorityError) {
            if (!isMissingArtifactError(authorityError)) {
                throw authorityError;
            }
            try {
                return await this.cache.getSkillArtifact(storageRef);
            }
            catch (cacheError) {
                throw new Error(`Skill artifact unavailable from remote authority or local cache: ${storageRef}. ` +
                    `Remote: ${errorMessage(authorityError)}; local: ${errorMessage(cacheError)}`, { cause: authorityError });
            }
        }
    }
    async tryWarmCache(input) {
        try {
            await this.cache.putSkillArtifact(input);
        }
        catch {
            // Local cache warming must never block the remote-authoritative write/read.
        }
    }
}
function skillNameFromStorageRef(storageRef) {
    const normalized = storageRef.replace(/\\/g, '/');
    const segment = normalized.split('/').filter(Boolean).at(-1);
    return segment ? path.posix.basename(segment) : 'skill';
}
function errorMessage(value) {
    return value instanceof Error ? value.message : String(value);
}
function isMissingArtifactError(value) {
    const message = errorMessage(value);
    return (message.includes('Skill artifact must contain SKILL.md') ||
        message.includes('NoSuchKey') ||
        message.includes('not found') ||
        message.includes('missing '));
}
