import { createHash } from 'node:crypto';
import { AgentProfileService, ProfileVersionConflictError, isProfileFileKind, } from '../application/agents/agent-profile-service.js';
import { FileArtifactNotFoundError } from '../domain/file-artifacts/file-artifact.js';
import { PROFILE_FILE_NAMES } from '../application/agents/prompt-profile-service.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import { writeProfileFileMirror } from '../platform/profile-file-mirror.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { sanitizeOutboundLlmText } from '../shared/sensitive-material.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
function createContextTaskResponder(context) {
    return createTaskResponder(context.sourceAgentFolder, context.data.taskId, context.data.authThreadId, context.data.responseKeyId);
}
function buildHostProfileService(context) {
    const { deps, data, sourceAgentFolder } = context;
    const appId = data.appId ?? 'default';
    return new AgentProfileService({
        appId,
        fileArtifactStore: () => deps.getFileArtifactStore?.(),
        mirrorProfileFile: writeProfileFileMirror,
        audit: deps.publishRuntimeEvent
            ? (input) => deps.publishRuntimeEvent?.({
                appId: appId,
                agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder),
                conversationId: data.chatJid,
                threadId: data.authThreadId,
                eventType: input.action === 'update'
                    ? RUNTIME_EVENT_TYPES.PROFILE_FILE_UPDATED
                    : RUNTIME_EVENT_TYPES.PROFILE_FILE_READ,
                actor: input.actor,
                payload: {
                    fileKind: input.kind,
                    version: input.version,
                    contentHash: input.contentHash,
                    actor: input.actor,
                    ...(input.approvalSource
                        ? { approvalSource: input.approvalSource }
                        : {}),
                },
            })
            : undefined,
    });
}
function validateSameChannel(context, reject) {
    const requestedTargetJid = toTrimmedString(context.data.chatJid, {
        maxLen: 512,
    });
    if (!requestedTargetJid ||
        !context.sourceAgentFolderJids.includes(requestedTargetJid)) {
        reject('Profile requests must include the originating chat for this agent.', 'forbidden');
        return null;
    }
    return requestedTargetJid;
}
function profileFileKindFromPayload(value) {
    const raw = toTrimmedString(value, { maxLen: 16 });
    return isProfileFileKind(raw) ? raw : null;
}
// Compact human-facing diff for the approval prompt. Keeps the preview small so
// it renders cleanly across channel adapters. Uses multiset (count-aware) line
// differences so duplicated lines are counted, and reports pure reorders rather
// than misreporting a real change as "0 removed, 0 added".
function buildProfileDiffPreview(previous, next) {
    if (previous === next)
        return 'No textual changes.';
    const prevLines = previous.split('\n');
    const nextLines = next.split('\n');
    const balance = new Map();
    for (const line of prevLines)
        balance.set(line, (balance.get(line) ?? 0) + 1);
    for (const line of nextLines)
        balance.set(line, (balance.get(line) ?? 0) - 1);
    const removed = [];
    const removeBudget = new Map(balance);
    for (const line of prevLines) {
        const surplus = removeBudget.get(line) ?? 0;
        if (surplus > 0) {
            removed.push(line);
            removeBudget.set(line, surplus - 1);
        }
    }
    const added = [];
    const addBudget = new Map();
    for (const [line, delta] of balance)
        if (delta < 0)
            addBudget.set(line, -delta);
    for (const line of nextLines) {
        const deficit = addBudget.get(line) ?? 0;
        if (deficit > 0) {
            added.push(line);
            addBudget.set(line, deficit - 1);
        }
    }
    if (removed.length === 0 && added.length === 0) {
        return 'Lines reordered (no additions or removals).';
    }
    const lines = [
        `${removed.length} line(s) removed, ${added.length} line(s) added.`,
    ];
    for (const line of removed.slice(0, 8))
        lines.push(`- ${line}`);
    for (const line of added.slice(0, 8))
        lines.push(`+ ${line}`);
    if (removed.length > 8 || added.length > 8)
        lines.push('… (truncated)');
    return lines.join('\n');
}
function profileContentHash(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}
const MAX_REVIEWABLE_PROFILE_UPDATE_BYTES = 3400;
function isFullyReviewableProfileContent(content) {
    const sanitized = sanitizeOutboundLlmText(content);
    return (!sanitized.redacted &&
        !sanitized.blocked &&
        !/\[REDACTED_(?:SECRET|POTENTIALLY_SENSITIVE)\]/.test(sanitized.text));
}
const agentProfileReadHandler = async (context) => {
    const { data, sourceAgentFolder } = context;
    const { acceptData, reject } = createContextTaskResponder(context);
    if (!data.appId) {
        reject('Profile requests require signed app scope.', 'forbidden');
        return;
    }
    if (!validateSameChannel(context, reject))
        return;
    if (!isValidWorkspaceFolder(sourceAgentFolder)) {
        reject('Profile files require a valid agent workspace.', 'invalid_request');
        return;
    }
    const kind = profileFileKindFromPayload(data.payload?.file);
    if (!kind) {
        reject('file must be soul or agents.', 'invalid_request');
        return;
    }
    try {
        const file = await buildHostProfileService(context).readProfileFile(sourceAgentFolder, kind, { actor: `agent:${sourceAgentFolder}` });
        acceptData('Profile file read.', { ok: true, ...file });
    }
    catch (err) {
        if (err instanceof FileArtifactNotFoundError) {
            reject('Profile file has not been created yet.', 'invalid_request');
            return;
        }
        reject(err instanceof Error ? err.message : 'Profile read failed.', 'invalid_request');
    }
};
const requestAgentProfileUpdateHandler = async (context) => {
    const { data, deps, sourceAgentFolder } = context;
    const { acceptData, reject } = createContextTaskResponder(context);
    if (!data.appId) {
        reject('Profile requests require signed app scope.', 'forbidden');
        return;
    }
    const requestedTargetJid = validateSameChannel(context, reject);
    if (!requestedTargetJid)
        return;
    if (!isValidWorkspaceFolder(sourceAgentFolder)) {
        reject('Profile files require a valid agent workspace.', 'invalid_request');
        return;
    }
    if (typeof deps.requestPermissionApproval !== 'function' ||
        typeof deps.sendMessage !== 'function') {
        reject('Profile updates require a configured approval surface.', 'preflight_failed');
        return;
    }
    const payload = data.payload || {};
    const kind = profileFileKindFromPayload(payload.file);
    if (!kind) {
        reject('file must be soul or agents.', 'invalid_request');
        return;
    }
    const content = typeof payload.content === 'string' ? payload.content : '';
    if (!content.trim()) {
        reject('content is required.', 'invalid_request');
        return;
    }
    const proposedContentBytes = Buffer.byteLength(content, 'utf8');
    if (proposedContentBytes > MAX_REVIEWABLE_PROFILE_UPDATE_BYTES) {
        reject(`Profile update is ${proposedContentBytes} bytes, which is too large to review safely in chat. Make a smaller targeted update or ask the user/admin to use gantry agent profile set/import.`, 'invalid_request');
        return;
    }
    const fileName = PROFILE_FILE_NAMES[kind];
    const summary = toTrimmedString(payload.summary, { maxLen: 2000 }) || `Update ${fileName}.`;
    const expectedVersion = typeof payload.expectedVersion === 'number'
        ? Math.floor(payload.expectedVersion)
        : undefined;
    if (expectedVersion === undefined) {
        reject('Read the profile file first with agent_profile_read and pass expectedVersion.', 'invalid_request');
        return;
    }
    if (!isFullyReviewableProfileContent(content)) {
        reject('Profile update contains sensitive material that cannot be fully shown for approval. Remove secrets or ask the user/admin to use gantry agent profile set/import outside chat.', 'invalid_request');
        return;
    }
    const profileService = buildHostProfileService(context);
    let currentContent = '';
    let currentVersion = 0;
    let currentHash = '';
    try {
        const current = await profileService.readProfileFile(sourceAgentFolder, kind);
        currentContent = current.content;
        currentVersion = current.version;
        currentHash = current.contentHash;
    }
    catch (err) {
        if (!(err instanceof FileArtifactNotFoundError)) {
            reject(err instanceof Error ? err.message : 'Profile read failed.', 'invalid_request');
            return;
        }
    }
    const relationshipMode = data.agentConfig?.relationshipMode ?? 'personal';
    const requestId = `agent-profile-${globalThis.crypto.randomUUID()}`;
    const proposedContentHash = profileContentHash(content);
    const decision = await deps.requestPermissionApproval({
        requestId,
        appId: data.appId,
        agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder),
        sourceAgentFolder,
        targetJid: requestedTargetJid,
        threadId: data.authThreadId,
        decisionPolicy: 'same_channel',
        decisionOptions: ['allow_once', 'cancel'],
        toolName: 'request_agent_profile_update',
        displayName: `Update ${fileName}`,
        title: `Allow ${sourceAgentFolder} to update ${fileName}?`,
        description: `Profile update for ${fileName} (current version ${currentVersion}). ${summary}`,
        decisionReason: summary,
        interaction: {
            id: requestId,
            title: `Update ${fileName}`,
            body: summary,
            severity: 'warning',
            requestContext: {
                requestId,
                sourceAgentFolder,
                targetJid: requestedTargetJid,
                threadId: data.authThreadId,
                toolName: 'request_agent_profile_update',
                capabilityType: 'profile_update',
                capabilityDisplayName: `Update ${fileName}`,
            },
            details: [
                { label: 'File', value: fileName },
                { label: 'Expected version', value: String(expectedVersion) },
                { label: 'Current hash', value: currentHash || '(none)', mono: true },
                { label: 'Proposed hash', value: proposedContentHash, mono: true },
                { label: 'Proposed size', value: `${proposedContentBytes} bytes` },
            ],
            files: [
                {
                    path: fileName,
                    sizeBytes: proposedContentBytes,
                    contentHash: proposedContentHash,
                    contentType: 'text/markdown',
                    preview: content,
                    truncated: false,
                },
            ],
        },
        toolInput: {
            file: kind,
            fileName,
            mode: relationshipMode,
            summary,
            currentVersion,
            currentHash,
            expectedVersion,
            proposedContentHash,
            proposedContentBytes,
            proposedContent: content,
            proposedContentEvidence: 'interaction.files[0].preview',
            diffPreview: buildProfileDiffPreview(currentContent, content),
        },
    });
    if (!decision.approved || !decision.decidedBy) {
        const message = `Profile update declined: ${decision.reason || 'not approved'}.`;
        reject(message, 'permission_denied');
        await deps.sendMessage(requestedTargetJid, message, data.authThreadId ? { threadId: data.authThreadId } : undefined);
        return;
    }
    try {
        const result = await profileService.writeProfileFile({
            agentFolder: sourceAgentFolder,
            kind,
            content,
            expectedVersion,
            actor: `agent:${sourceAgentFolder}`,
            approvalSource: 'allow_once',
        });
        acceptData(`Updated ${fileName}. It applies on the next run.`, {
            ok: true,
            file: kind,
            version: result.version,
            contentHash: result.contentHash,
        });
    }
    catch (err) {
        if (err instanceof ProfileVersionConflictError) {
            reject(`${err.message} Latest version is ${err.latestVersion}.`, 'conflict');
            return;
        }
        reject(err instanceof Error ? err.message : 'Profile update failed.', 'invalid_request');
    }
};
export const agentProfileTaskHandlers = {
    agent_profile_read: agentProfileReadHandler,
    request_agent_profile_update: requestAgentProfileUpdateHandler,
};
