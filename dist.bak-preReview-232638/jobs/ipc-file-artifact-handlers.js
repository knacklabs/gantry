import { describeFileArtifact, } from '../domain/file-artifacts/file-artifact.js';
import { isAgentProfileArtifactWrite, isProtectedFileArtifactVirtualPath, } from '../domain/file-artifacts/protected-virtual-path.js';
import { normalizeFileArtifactPath, normalizeFileArtifactScope, } from '../domain/file-artifacts/virtual-path.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { sourceAgentHasAdminToolCapability } from './ipc-admin-authorization.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
const DEFAULT_READ_LIMIT_BYTES = 64 * 1024;
const MAX_READ_LIMIT_BYTES = 256 * 1024;
function createContextTaskResponder(context) {
    return createTaskResponder(context.sourceAgentFolder, context.data.taskId, context.data.authThreadId, context.data.responseKeyId);
}
const fileArtifactHandler = async (context) => {
    const { data, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createContextTaskResponder(context);
    if (!data.appId) {
        reject('FileArtifact requests require signed app scope.', 'forbidden');
        return;
    }
    const requestedTargetJid = validateSameChannelTarget({
        context,
        sourceAgentFolderJids,
        requestKind: 'FileArtifact',
        reject,
    });
    if (!requestedTargetJid)
        return;
    const payload = data.payload || {};
    const action = toTrimmedString(payload.action, { maxLen: 32 });
    if (action !== 'list' &&
        action !== 'read' &&
        action !== 'write' &&
        action !== 'promote_scratch') {
        reject('Unsupported FileArtifact action.', 'invalid_request');
        return;
    }
    try {
        const store = context.deps.getFileArtifactStore?.();
        if (!store) {
            reject('FileArtifact storage is not ready.', 'preflight_failed');
            return;
        }
        const owner = {
            appId: data.appId,
            agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder),
        };
        if (action === 'list') {
            const artifacts = await store.listFileArtifacts({
                ...owner,
                ...(payload.scope
                    ? { virtualScope: normalizeFileArtifactScope(String(payload.scope)) }
                    : {}),
                ...(payload.path
                    ? { virtualPath: normalizeFileArtifactPath(String(payload.path)) }
                    : {}),
                limit: toBoundedLimit(payload.limit, 50, 100),
            });
            acceptData('FileArtifacts listed.', { ok: true, artifacts });
            return;
        }
        if (action === 'read') {
            const artifactId = toTrimmedString(payload.artifactId, { maxLen: 160 });
            const virtualScope = payload.scope
                ? normalizeFileArtifactScope(String(payload.scope))
                : undefined;
            const virtualPath = payload.path
                ? normalizeFileArtifactPath(String(payload.path))
                : undefined;
            if (!artifactId && !virtualPath) {
                reject('FileArtifact read requires artifactId or path.', 'invalid_request');
                return;
            }
            const result = await store.readFileArtifact({
                ...owner,
                ...(artifactId ? { id: artifactId } : {}),
                ...(virtualScope ? { virtualScope } : {}),
                ...(virtualPath ? { virtualPath } : {}),
                ...(typeof payload.version === 'number'
                    ? { version: Math.floor(payload.version) }
                    : {}),
            });
            acceptData('FileArtifact read.', {
                ok: true,
                artifact: describeFileArtifact(result.artifact),
                content: encodeFileArtifactContent(result.content, {
                    offset: typeof payload.offset === 'number' ? payload.offset : 0,
                    limit: typeof payload.readLimit === 'number'
                        ? payload.readLimit
                        : DEFAULT_READ_LIMIT_BYTES,
                }),
            });
            return;
        }
        if (action === 'write') {
            const virtualPath = normalizeFileArtifactPath(String(payload.path || ''));
            const virtualScope = normalizeFileArtifactScope(String(payload.scope || 'default'));
            if (!(await authorizeProtectedPromptMutation(context, virtualScope, virtualPath, reject))) {
                return;
            }
            const content = decodeFileArtifactContent(payload.content, payload.encoding);
            const artifact = await store.writeFileArtifact({
                ...owner,
                virtualScope,
                virtualPath,
                content,
                contentType: toTrimmedString(payload.contentType, { maxLen: 255 }) ||
                    (payload.encoding === 'base64'
                        ? 'application/octet-stream'
                        : 'text/plain; charset=utf-8'),
                createdBy: `agent:${sourceAgentFolder}`,
            });
            acceptData('FileArtifact written.', {
                ok: true,
                artifact: describeFileArtifact(artifact),
            });
            return;
        }
        const scratchPath = normalizeFileArtifactPath(String(payload.path || ''));
        const targetPath = normalizeFileArtifactPath(String(payload.targetPath || ''));
        const targetScope = normalizeFileArtifactScope(String(payload.targetScope || 'default'));
        if (!(await authorizeProtectedPromptMutation(context, targetScope, targetPath, reject))) {
            return;
        }
        const artifact = await store.promoteScratch({
            ...owner,
            scratchPath,
            targetScope,
            targetPath,
            createdBy: `agent:${sourceAgentFolder}`,
        });
        acceptData('FileArtifact promoted.', {
            ok: true,
            artifact: describeFileArtifact(artifact),
        });
    }
    catch (err) {
        reject(err instanceof Error ? err.message : 'FileArtifact request failed.', 'invalid_request');
    }
};
export const fileArtifactTaskHandlers = {
    file_artifact: fileArtifactHandler,
};
function validateSameChannelTarget(input) {
    const requestedTargetJid = toTrimmedString(input.context.data.chatJid, {
        maxLen: 512,
    });
    const targetOverride = toTrimmedString(input.context.data.targetJid || input.context.data.jid, { maxLen: 512 });
    if (targetOverride && targetOverride !== requestedTargetJid) {
        input.reject(`${input.requestKind} requests must use the originating chat as the approval target.`, 'forbidden');
        return null;
    }
    if (!requestedTargetJid ||
        !input.sourceAgentFolderJids.includes(requestedTargetJid)) {
        input.reject(`${input.requestKind} requests must include the originating chat for this agent.`, 'forbidden');
        return null;
    }
    return requestedTargetJid;
}
async function authorizeProtectedPromptMutation(context, virtualScope, virtualPath, reject) {
    if (isAgentProfileArtifactWrite(virtualScope, virtualPath)) {
        reject('Profile files (SOUL.md, AGENTS.md) cannot be written through the file tool. Use request_agent_profile_update.', 'forbidden');
        return false;
    }
    if (!isProtectedPromptPath(virtualPath))
        return true;
    const protectedRequested = context.data.payload?.protected === true;
    const authorized = protectedRequested &&
        (await sourceAgentHasAdminToolCapability(context, 'request_settings_update'));
    if (authorized)
        return true;
    reject('Protected prompt FileArtifact mutations require request_settings_update capability and protected=true.', 'missing_capability');
    return false;
}
function toBoundedLimit(value, fallback, maxLimit) {
    const parsed = typeof value === 'number' ? Math.floor(value) : fallback;
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.min(parsed, maxLimit);
}
function isProtectedPromptPath(virtualPath) {
    return isProtectedFileArtifactVirtualPath(virtualPath);
}
function decodeFileArtifactContent(content, encoding) {
    if (typeof content !== 'string' || content.length > 2_000_000) {
        throw new Error('FileArtifact write requires content.');
    }
    if (encoding === 'base64')
        return Buffer.from(content, 'base64');
    return content;
}
function encodeFileArtifactContent(content, window) {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const offset = Math.min(Math.max(Math.floor(window.offset), 0), bytes.byteLength);
    const limit = Math.min(Math.max(Math.floor(window.limit), 1), MAX_READ_LIMIT_BYTES);
    const sliced = bytes.subarray(offset, Math.min(bytes.byteLength, offset + limit));
    const common = {
        offset,
        bytesReturned: sliced.byteLength,
        totalBytes: bytes.byteLength,
        truncated: offset + sliced.byteLength < bytes.byteLength,
    };
    if (typeof content === 'string') {
        return { encoding: 'utf8', text: sliced.toString('utf-8'), ...common };
    }
    return {
        encoding: 'base64',
        data: Buffer.from(sliced).toString('base64'),
        ...common,
    };
}
