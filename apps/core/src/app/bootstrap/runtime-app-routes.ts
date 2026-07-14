import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import type { ConversationRoute } from '../../domain/types.js';
import {
  findConversationRouteForQueue,
  makeAgentThreadQueueKey,
} from '../../shared/thread-queue-key.js';

export function resolveConversationRoute(
  routes: Record<string, ConversationRoute>,
  chatJid: string,
  threadId?: string | null,
  agentId?: string | null,
  providerAccountId?: string | null,
): ConversationRoute | undefined {
  return findConversationRouteForQueue(
    routes,
    makeAgentThreadQueueKey(chatJid, agentId, threadId, providerAccountId),
    (route) => route.agentId ?? agentIdForFolder(route.folder),
  );
}
