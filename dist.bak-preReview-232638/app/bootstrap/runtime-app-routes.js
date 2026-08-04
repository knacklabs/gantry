import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { findConversationRouteForQueue, makeAgentThreadQueueKey, routesForConversationId, } from '../../shared/thread-queue-key.js';
export function resolveConversationRoute(routes, chatJid, threadId, agentId, providerAccountId, conversationId) {
    return findConversationRouteForQueue(conversationId ? routesForConversationId(routes, conversationId) : routes, makeAgentThreadQueueKey(chatJid, agentId, threadId, providerAccountId), (route) => route.agentId ?? agentIdForFolder(route.folder));
}
