import fs from 'fs';
import path from 'path';
import { ASSISTANT_NAME as DEFAULT_ASSISTANT_NAME } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { resolveModelAlias, resolveModelSelectionForWorkload, } from '../shared/model-catalog.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import { profileFileMirrorExists, writeProfileFileMirror, } from '../platform/profile-file-mirror.js';
import { PromptProfileService } from '../application/agents/prompt-profile-service.js';
import { resolveAgentLockStatus } from '../config/profiles.js';
import { parseAgentThreadQueueKey } from '../shared/thread-queue-key.js';
function isPromiseLike(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'then' in value &&
        typeof value.then === 'function');
}
function commitGroupOverride(conversationRoutes, chatJid, updatedGroup, persisted, logContext, logMessage) {
    const commit = () => {
        conversationRoutes[chatJid] = updatedGroup;
        logger.info(logContext, logMessage);
    };
    if (isPromiseLike(persisted)) {
        return persisted.then(commit);
    }
    commit();
}
export async function ensureRouteProfileDefaults(routes, options = {}) {
    const seenFolders = new Set();
    const profileService = new PromptProfileService({
        fileArtifactStore: () => options.getFileArtifactStore?.(),
        mirrorProfileFile: writeProfileFileMirror,
        mirrorFileExists: profileFileMirrorExists,
    });
    for (const route of routes) {
        const folder = route.folder;
        if (seenFolders.has(folder))
            continue;
        seenFolders.add(folder);
        await profileService.ensureAgentDefaults({
            agentFolder: folder,
            agentName: options.assistantName ?? route.name,
            relationshipMode: route.agentConfig?.relationshipMode,
            accessPreset: resolveAgentLockStatus(folder) === 'locked' ? 'locked' : 'full',
        });
    }
    return seenFolders.size;
}
export async function registerGroup(conversationRoutes, jid, group, options) {
    const assistantName = options.assistantName ?? DEFAULT_ASSISTANT_NAME;
    let groupDir;
    try {
        groupDir = resolveWorkspaceFolderPath(group.folder);
    }
    catch (err) {
        logger.warn({ jid, folder: group.folder, err }, 'Rejecting group registration with invalid folder');
        return;
    }
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    await ensureRouteProfileDefaults([group], {
        assistantName,
        getFileArtifactStore: options.getFileArtifactStore,
    });
    conversationRoutes[jid] = group;
    await options.persist(jid, group);
    options.ensureCredentialBinding(jid, group);
    logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}
export function setGroupModelOverride(conversationRoutes, chatJid, model, persist) {
    const existingGroup = conversationRoutes[chatJid];
    if (!existingGroup)
        return;
    const trimmedModel = typeof model === 'string' ? model.trim() : '';
    if (trimmedModel) {
        const resolved = resolveModelSelectionForWorkload(trimmedModel, 'chat');
        if (!resolved.ok) {
            throw new Error(resolved.message);
        }
    }
    const normalizedModel = resolveModelAlias(model);
    const prevModel = existingGroup.agentConfig?.model;
    if (prevModel === normalizedModel)
        return;
    const nextAgentConfig = { ...(existingGroup.agentConfig || {}) };
    if (normalizedModel) {
        nextAgentConfig.model = normalizedModel;
    }
    else {
        delete nextAgentConfig.model;
    }
    const updatedGroup = {
        ...existingGroup,
        agentConfig: Object.keys(nextAgentConfig).length > 0 ? nextAgentConfig : undefined,
    };
    const persisted = persist(chatJid, updatedGroup);
    return commitGroupOverride(conversationRoutes, chatJid, updatedGroup, persisted, {
        group: updatedGroup.name,
        modelOverride: normalizedModel ?? null,
    }, 'Updated group model override');
}
export function setGroupThinkingOverride(conversationRoutes, chatJid, thinking, persist) {
    const existingGroup = conversationRoutes[chatJid];
    if (!existingGroup)
        return;
    const prevThinking = existingGroup.agentConfig?.thinking;
    if (JSON.stringify(prevThinking || null) === JSON.stringify(thinking || null))
        return;
    const nextAgentConfig = { ...(existingGroup.agentConfig || {}) };
    if (thinking) {
        nextAgentConfig.thinking = thinking;
    }
    else {
        delete nextAgentConfig.thinking;
    }
    const updatedGroup = {
        ...existingGroup,
        agentConfig: Object.keys(nextAgentConfig).length > 0 ? nextAgentConfig : undefined,
    };
    const persisted = persist(chatJid, updatedGroup);
    return commitGroupOverride(conversationRoutes, chatJid, updatedGroup, persisted, {
        group: updatedGroup.name,
        thinkingOverride: thinking ?? null,
    }, 'Updated group thinking override');
}
export function setGroupPermissionModeOverride(conversationRoutes, chatJid, permissionMode, persist) {
    const existingGroup = conversationRoutes[chatJid];
    if (!existingGroup ||
        existingGroup.agentConfig?.permissionMode === permissionMode)
        return;
    const nextAgentConfig = { ...(existingGroup.agentConfig || {}) };
    if (permissionMode)
        nextAgentConfig.permissionMode = permissionMode;
    else
        delete nextAgentConfig.permissionMode;
    const updatedGroup = {
        ...existingGroup,
        agentConfig: Object.keys(nextAgentConfig).length > 0 ? nextAgentConfig : undefined,
    };
    return commitGroupOverride(conversationRoutes, chatJid, updatedGroup, persist(chatJid, updatedGroup), {
        group: updatedGroup.name,
        permissionModeOverride: permissionMode ?? null,
    }, 'Updated group permission mode override');
}
export function listAvailableGroups(chats, conversationRoutes) {
    const registeredJids = new Set(Object.keys(conversationRoutes).map((jid) => parseAgentThreadQueueKey(jid).chatJid));
    return chats
        .filter((c) => c.jid !== '__group_sync__' && Boolean(c.is_group))
        .map((c) => ({
        jid: c.jid,
        name: c.name || c.jid,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
    }));
}
