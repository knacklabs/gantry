import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import { makeAgentThreadQueueKey, parseAgentThreadQueueKey, } from '../shared/thread-queue-key.js';
import { appIdFromConversationJid } from '../shared/app-conversation-jid.js';
export function resolveGroupProcessingRouteContext(deps, queueJid) {
    const { chatJid, threadId, agentId, providerAccountId } = parseAgentThreadQueueKey(queueJid);
    const routeKey = makeAgentThreadQueueKey(chatJid, agentId, threadId, providerAccountId);
    const group = deps.getGroup(chatJid, threadId, agentId, providerAccountId);
    if (!group)
        return null;
    return {
        chatJid,
        threadId,
        agentId,
        routeKey,
        turnAppId: appIdFromConversationJid(chatJid) ?? 'default',
        group,
        commandOverrideRouteKey: resolveCommandOverrideRouteKey({
            chatJid,
            threadId,
            providerAccountId,
            queueAgentId: agentId,
            agentFolder: group.folder,
            registeredJids: deps.getRegisteredJids(),
            routeKey,
        }),
    };
}
export function resolveCommandOverrideRouteKey(input) {
    if (input.registeredJids.has(input.routeKey))
        return input.routeKey;
    const routeAgentId = agentIdForFolder(input.agentFolder);
    const candidates = [
        input.threadId
            ? makeAgentThreadQueueKey(input.chatJid, routeAgentId, input.threadId, input.providerAccountId)
            : null,
        makeAgentThreadQueueKey(input.chatJid, routeAgentId, null, input.providerAccountId),
        input.queueAgentId
            ? makeAgentThreadQueueKey(input.chatJid, input.queueAgentId, null, input.providerAccountId)
            : null,
        input.providerAccountId
            ? makeAgentThreadQueueKey(input.chatJid, null, null, input.providerAccountId)
            : input.chatJid,
    ];
    return (candidates.find((candidate) => candidate != null && input.registeredJids.has(candidate)) ?? input.routeKey);
}
