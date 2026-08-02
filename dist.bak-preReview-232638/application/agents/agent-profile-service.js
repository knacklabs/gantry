import { FileArtifactNotFoundError, FileArtifactVersionConflictError, } from '../../domain/file-artifacts/file-artifact.js';
import { PROFILE_FILE_NAMES, PROMPT_PROFILE_VIRTUAL_SCOPE, promptProfileAgentIdForFolder, promptProfileAgentsPath, promptProfileSoulPath, } from './prompt-profile-service.js';
export const PROFILE_FILE_KINDS = ['soul', 'agents'];
const DEFAULT_PROFILE_APP_ID = 'default';
// Upper bound on profile content, matching the generic file-tool write cap.
// Profile writes bypass that path, so the bound is enforced here at the shared
// write choke point (covers both the control API and the IPC tool).
export const MAX_PROFILE_CONTENT_BYTES = 2_000_000;
export class ProfileContentTooLargeError extends Error {
    maxBytes;
    constructor(maxBytes) {
        super(`Profile content exceeds the ${maxBytes}-byte limit. Shorten it and retry.`);
        this.maxBytes = maxBytes;
        this.name = 'ProfileContentTooLargeError';
    }
}
export function isProfileFileKind(value) {
    return (typeof value === 'string' &&
        PROFILE_FILE_KINDS.includes(value));
}
export class ProfileVersionConflictError extends Error {
    latestVersion;
    constructor(latestVersion) {
        super('Profile file changed since you last read it. Refresh the latest version and retry.');
        this.latestVersion = latestVersion;
        this.name = 'ProfileVersionConflictError';
    }
}
function profileVirtualPath(kind, agentFolder) {
    return kind === 'soul'
        ? promptProfileSoulPath(agentFolder)
        : promptProfileAgentsPath(agentFolder);
}
export class AgentProfileService {
    fileArtifactStore;
    appId;
    mirrorProfileFile;
    audit;
    onSideEffectError;
    constructor(options) {
        this.fileArtifactStore = options.fileArtifactStore;
        this.appId = options.appId || DEFAULT_PROFILE_APP_ID;
        this.mirrorProfileFile = options.mirrorProfileFile;
        this.audit = options.audit;
        this.onSideEffectError = options.onSideEffectError;
    }
    requireStore() {
        const store = this.fileArtifactStore();
        if (!store)
            throw new Error('FileArtifact storage is not ready.');
        return store;
    }
    async latestDescriptor(agentFolder, kind) {
        const store = this.requireStore();
        const existing = await store.listFileArtifacts({
            appId: this.appId,
            agentId: promptProfileAgentIdForFolder(agentFolder),
            virtualScope: PROMPT_PROFILE_VIRTUAL_SCOPE,
            virtualPath: profileVirtualPath(kind, agentFolder),
            limit: 1,
        });
        return existing[0] ?? null;
    }
    async listProfileFiles(agentFolder) {
        const summaries = [];
        for (const kind of PROFILE_FILE_KINDS) {
            const latest = await this.latestDescriptor(agentFolder, kind);
            summaries.push({
                kind,
                path: PROFILE_FILE_NAMES[kind],
                version: latest?.version ?? 0,
                contentHash: latest?.contentHash ?? '',
                sizeBytes: latest?.sizeBytes ?? 0,
                updatedAt: latest?.createdAt ?? null,
            });
        }
        return summaries;
    }
    async readProfileFile(agentFolder, kind, options = {}) {
        const store = this.requireStore();
        const result = await store.readFileArtifact({
            appId: this.appId,
            agentId: promptProfileAgentIdForFolder(agentFolder),
            virtualScope: PROMPT_PROFILE_VIRTUAL_SCOPE,
            virtualPath: profileVirtualPath(kind, agentFolder),
        });
        const content = typeof result.content === 'string'
            ? result.content
            : Buffer.from(result.content).toString('utf-8');
        if (this.audit) {
            try {
                await this.audit({
                    action: 'read',
                    agentFolder,
                    kind,
                    version: result.artifact.version,
                    contentHash: result.artifact.contentHash,
                    actor: options.actor ?? 'system',
                });
            }
            catch (error) {
                await this.reportSideEffectError({
                    sideEffect: 'audit',
                    error,
                    agentFolder,
                    kind,
                    version: result.artifact.version,
                });
            }
        }
        return {
            kind,
            path: PROFILE_FILE_NAMES[kind],
            version: result.artifact.version,
            contentHash: result.artifact.contentHash,
            content,
        };
    }
    async writeProfileFile(input) {
        if (Buffer.byteLength(input.content, 'utf-8') > MAX_PROFILE_CONTENT_BYTES) {
            throw new ProfileContentTooLargeError(MAX_PROFILE_CONTENT_BYTES);
        }
        const store = this.requireStore();
        const latest = await this.latestDescriptor(input.agentFolder, input.kind);
        const latestVersion = latest?.version ?? 0;
        // Fast-fail on a stale read; the store re-checks expectedVersion atomically
        // under its version-path lock to also catch concurrent same-version writers.
        if (input.expectedVersion !== undefined &&
            input.expectedVersion !== latestVersion) {
            throw new ProfileVersionConflictError(latestVersion);
        }
        let artifact;
        try {
            artifact = await store.writeFileArtifact({
                appId: this.appId,
                agentId: promptProfileAgentIdForFolder(input.agentFolder),
                virtualScope: PROMPT_PROFILE_VIRTUAL_SCOPE,
                virtualPath: profileVirtualPath(input.kind, input.agentFolder),
                content: input.content,
                contentType: 'text/markdown',
                createdBy: input.createdBy ?? input.actor,
                metadata: { promptProfileKind: input.kind },
                ...(input.expectedVersion !== undefined
                    ? { expectedVersion: input.expectedVersion }
                    : {}),
            });
        }
        catch (err) {
            if (err instanceof FileArtifactVersionConflictError) {
                throw new ProfileVersionConflictError(err.latestVersion);
            }
            throw err;
        }
        if (this.mirrorProfileFile) {
            try {
                await this.mirrorProfileFile({
                    agentFolder: input.agentFolder,
                    fileName: PROFILE_FILE_NAMES[input.kind],
                    content: input.content,
                });
            }
            catch (error) {
                await this.reportSideEffectError({
                    sideEffect: 'mirror',
                    error,
                    agentFolder: input.agentFolder,
                    kind: input.kind,
                    version: artifact.version,
                });
            }
        }
        if (this.audit) {
            try {
                await this.audit({
                    action: 'update',
                    agentFolder: input.agentFolder,
                    kind: input.kind,
                    version: artifact.version,
                    contentHash: artifact.contentHash,
                    actor: input.actor,
                    approvalSource: input.approvalSource,
                });
            }
            catch (error) {
                await this.reportSideEffectError({
                    sideEffect: 'audit',
                    error,
                    agentFolder: input.agentFolder,
                    kind: input.kind,
                    version: artifact.version,
                });
            }
        }
        return { version: artifact.version, contentHash: artifact.contentHash };
    }
    async reportSideEffectError(input) {
        if (!this.onSideEffectError)
            return;
        try {
            await this.onSideEffectError(input);
        }
        catch {
            // The durable profile write already succeeded; reporting failures must
            // not make callers believe the profile update was rolled back.
        }
    }
}
export { FileArtifactNotFoundError };
