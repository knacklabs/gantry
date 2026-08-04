import { agentIdForFolder, folderForAgentId, } from '../../domain/agent/agent-folder-id.js';
import { normalizeRuntimeSecretRefString } from '../../domain/ports/runtime-secret-provider.js';
import { jidForConfiguredConversation, providerTopology, } from './desired-state-provider-conversations.js';
import { findConversationRouteForQueue, makeAgentThreadQueueKey, normalizeThreadQueueId, parseAgentThreadQueueKey, } from '../../shared/thread-queue-key.js';
export { agentIdForFolder, folderForAgentId };
export function configuredRoutingBindingsByAgent(settings, existingRoutes = {}) {
    const result = new Map();
    for (const binding of configuredRoutingBindings(settings, existingRoutes)) {
        const entries = result.get(binding.agentFolder) ?? [];
        entries.push(binding);
        result.set(binding.agentFolder, entries);
    }
    return result;
}
export function configuredAgentConfig(binding, agent) {
    const config = {
        model: binding.model,
        permissionMode: binding.permissionMode,
        persona: agent?.persona,
        relationshipMode: agent?.relationshipMode,
    };
    return Object.values(config).some(Boolean) ? config : undefined;
}
function canonicalRouteConversationId(jid, providerAccountId) {
    const normalizedProviderAccountId = providerAccountId?.trim();
    if (!normalizedProviderAccountId)
        return undefined;
    const { chatJid } = parseAgentThreadQueueKey(jid);
    return `conversation:${normalizedProviderAccountId}:${chatJid}`;
}
function configuredRouteConversationId(input) {
    const existingRoute = findConversationRouteForQueue(input.existingRoutes, makeAgentThreadQueueKey(input.jid, agentIdForFolder(input.agentFolder), input.threadId, input.providerAccountId), (route) => agentIdForFolder(route.folder)) ??
        findConversationRouteForQueue(input.existingRoutes, makeAgentThreadQueueKey(input.jid, input.agentFolder, input.threadId, input.providerAccountId), (route) => folderForAgentId(agentIdForFolder(route.folder)) ?? route.folder);
    // Existing legacy IDs stay authoritative; Phase 8 owns their restamp.
    return (existingRoute?.conversationId ??
        canonicalRouteConversationId(input.jid, input.providerAccountId));
}
function configuredInstallForAgentThread(conversation, agentId, threadId) {
    const normalizedThreadId = normalizeThreadQueueId(threadId);
    const matchesAgentThread = (install) => install.agentId === agentId &&
        normalizeThreadQueueId(install.threadId) === normalizedThreadId;
    const installedAgents = conversation.installedAgents ?? {};
    const directlyKeyedInstall = installedAgents[agentId];
    if (directlyKeyedInstall && matchesAgentThread(directlyKeyedInstall)) {
        return directlyKeyedInstall;
    }
    return Object.values(installedAgents).find(matchesAgentThread);
}
export function configuredRoutingBindings(settings, existingRoutes = {}) {
    const byAgentAndJid = new Map();
    for (const [folder, agent] of Object.entries(settings.agents)) {
        for (const binding of Object.values(agent.bindings)) {
            const configuredConversationCandidates = Object.entries(settings.conversations).filter(([, candidate]) => {
                if (jidForConfiguredConversation(candidate, settings.providerAccounts) !==
                    binding.jid) {
                    return false;
                }
                if (!binding.providerAccountId)
                    return true;
                const candidateInstall = configuredInstallForAgentThread(candidate, folder, binding.threadId);
                const candidateProviderAccountId = candidateInstall?.providerAccountId ??
                    candidate.providerAccount ??
                    candidate.providerConnection;
                return candidateProviderAccountId === binding.providerAccountId;
            });
            const configuredConversation = configuredConversationCandidates.length === 1
                ? configuredConversationCandidates[0]
                : undefined;
            const configuredInstall = configuredConversation
                ? configuredInstallForAgentThread(configuredConversation[1], folder, binding.threadId)
                : undefined;
            const providerAccountId = binding.providerAccountId ??
                configuredInstall?.providerAccountId ??
                configuredConversation?.[1].providerAccount ??
                configuredConversation?.[1].providerConnection;
            byAgentAndJid.set(`${folder}\0${providerAccountId ?? ''}\0${binding.jid}\0${binding.threadId ?? ''}`, {
                agentFolder: folder,
                conversationId: configuredRouteConversationId({
                    existingRoutes,
                    agentFolder: folder,
                    jid: binding.jid,
                    threadId: binding.threadId,
                    providerAccountId,
                }),
                jid: binding.jid,
                threadId: binding.threadId,
                providerAccountId,
                name: binding.name,
                trigger: binding.trigger,
                addedAt: binding.addedAt,
                requiresTrigger: binding.requiresTrigger,
                model: binding.model,
                permissionMode: binding.permissionMode,
                conversation: configuredConversation?.[1],
            });
        }
    }
    for (const binding of Object.values(settings.bindings)) {
        if (!settings.agents[binding.agent])
            continue;
        const conversation = settings.conversations[binding.conversation];
        if (!conversation)
            continue;
        const jid = jidForConfiguredConversation(conversation, settings.providerAccounts);
        const install = conversation.installedAgents?.[binding.installKey ?? binding.agent];
        const providerAccountId = install?.providerAccountId ??
            conversation.providerAccount ??
            conversation.providerConnection;
        byAgentAndJid.set(`${binding.agent}\0${providerAccountId ?? ''}\0${jid}\0${binding.threadId ?? ''}`, {
            agentFolder: binding.agent,
            conversationId: configuredRouteConversationId({
                existingRoutes,
                agentFolder: binding.agent,
                jid,
                threadId: binding.threadId,
                providerAccountId,
            }),
            jid,
            installKey: binding.installKey,
            threadId: binding.threadId,
            providerAccountId,
            name: conversation.displayName,
            trigger: binding.trigger,
            addedAt: binding.addedAt,
            requiresTrigger: binding.requiresTrigger,
            model: binding.model,
            permissionMode: binding.permissionMode,
            conversation,
        });
    }
    return [...byAgentAndJid.values()].sort((left, right) => `${left.agentFolder}:${left.providerAccountId ?? ''}:${left.jid}`.localeCompare(`${right.agentFolder}:${right.providerAccountId ?? ''}:${right.jid}`));
}
export function memorySubjectForConfiguredBinding(input) {
    switch (input.memoryScope) {
        case 'app':
            return {
                kind: 'app',
                appId: input.appId,
            };
        case 'agent':
            return {
                kind: 'agent',
                appId: input.appId,
                agentId: input.agentId,
            };
        case 'user':
            if (input.conversation.kind === 'dm' ||
                input.conversation.kind === 'direct') {
                return {
                    kind: 'user',
                    appId: input.appId,
                    userId: input.conversation.externalId,
                };
            }
            return {
                kind: 'agent',
                appId: input.appId,
                agentId: input.agentId,
            };
        case 'conversation':
            return {
                kind: 'conversation',
                appId: input.appId,
                conversationId: input.conversationId,
            };
    }
}
export function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
export function listDbOnlyGroupJids(input) {
    return [
        ...new Set([
            ...Object.keys(input.groups),
            ...input.chats
                .filter((chat) => chat.is_group === 1)
                .map((chat) => chat.jid),
        ]),
    ]
        .filter((jid) => !input.configuredJids.has(jid))
        .sort();
}
export function normalizeUserIds(userIds) {
    return [
        ...new Set(userIds
            .filter((id) => typeof id === 'string')
            .map((id) => id.trim())
            .filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
}
export function isValidExternalUserId(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
}
export function isInternalProviderAccount(providerId) {
    return providerId === 'app' || providerId === 'control-http';
}
export function normalizeRuntimeSecretRefs(input) {
    return Object.fromEntries(Object.entries(input.refs).map(([key, value]) => [
        key,
        normalizeRuntimeSecretRefString(value, `${input.pathPrefix}.${key}`),
    ]));
}
export function classifySettingsChanges(before, after) {
    const liveApplied = [];
    const restartRequired = [];
    if (!jsonEqual(before.storage, after.storage)) {
        restartRequired.push('storage');
    }
    if (!jsonEqual(before.credentialBroker, after.credentialBroker)) {
        restartRequired.push('model_access');
    }
    const providerTopologyChanged = !jsonEqual(providerTopology(before), providerTopology(after));
    if (providerTopologyChanged) {
        restartRequired.push('providers');
    }
    if (!providerTopologyChanged &&
        (!jsonEqual(before.conversations, after.conversations) ||
            !jsonEqual(before.bindings, after.bindings))) {
        liveApplied.push('conversation_policies');
    }
    if (!jsonEqual(before.agent, after.agent)) {
        liveApplied.push('agent_defaults');
    }
    if (!jsonEqual(before.agents, after.agents)) {
        restartRequired.push('agents');
    }
    if (!jsonEqual(before.memory, after.memory)) {
        restartRequired.push('memory');
    }
    if (!jsonEqual(before.runtime, after.runtime)) {
        restartRequired.push('runtime');
    }
    // Tracing initializes once at boot from authoritative settings.
    if (!jsonEqual(before.observability, after.observability)) {
        restartRequired.push('observability');
    }
    if (!jsonEqual(before.observer, after.observer)) {
        restartRequired.push('observer');
    }
    return {
        liveApplied: [...new Set(liveApplied)].sort(),
        restartRequired: [...new Set(restartRequired)].sort(),
    };
}
export function hasAnyCapability(agent) {
    return (agent.capabilities.length > 0 ||
        agent.sources.skills.length > 0 ||
        agent.sources.mcpServers.length > 0 ||
        agent.sources.tools.length > 0);
}
export function groupByAgentId(rows) {
    const result = new Map();
    for (const row of rows) {
        const existing = result.get(row.agentId);
        if (existing) {
            existing.push(row);
        }
        else {
            result.set(row.agentId, [row]);
        }
    }
    return result;
}
export function groupByConversationId(rows) {
    const result = new Map();
    for (const row of rows) {
        const existing = result.get(row.conversationId);
        if (existing) {
            existing.push(row);
        }
        else {
            result.set(row.conversationId, [row]);
        }
    }
    return result;
}
export function storedConversationKey(providerConnectionId, externalConversationId) {
    return `${providerConnectionId}\0${externalConversationId}`;
}
function jsonEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
export async function loadToolsById(repository, toolIds) {
    const tools = await Promise.all(toolIds.map(async (toolId) => [toolId, await repository.getTool(toolId)]));
    return new Map(tools);
}
export async function loadMcpServersById(repository, serverIds) {
    const servers = await Promise.all(serverIds.map(async (serverId) => [serverId, await repository.getServer(serverId)]));
    return new Map(servers);
}
