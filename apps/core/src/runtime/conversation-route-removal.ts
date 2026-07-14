import { parseAgentThreadQueueKey } from '../shared/thread-queue-key.js';
import type { ConversationRoute } from '../domain/types.js';

export function conversationRouteKeysForRemoval(
  conversationRoutes: Record<string, ConversationRoute>,
  jid: string,
): string[] {
  const parsedJid = parseAgentThreadQueueKey(jid);
  if (
    Object.hasOwn(conversationRoutes, jid) &&
    (parsedJid.chatJid !== jid || parsedJid.agentId || parsedJid.threadId)
  ) {
    return [jid];
  }
  return Object.keys(conversationRoutes).filter(
    (key) => parseAgentThreadQueueKey(key).chatJid === jid,
  );
}
