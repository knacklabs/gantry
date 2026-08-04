import { parseAgentThreadQueueKey } from '../shared/thread-queue-key.js';
export function conversationRouteKeysForRemoval(conversationRoutes, jid) {
    const parsedJid = parseAgentThreadQueueKey(jid);
    if (Object.hasOwn(conversationRoutes, jid) &&
        (parsedJid.chatJid !== jid || parsedJid.agentId || parsedJid.threadId)) {
        return [jid];
    }
    return Object.keys(conversationRoutes).filter((key) => parseAgentThreadQueueKey(key).chatJid === jid);
}
