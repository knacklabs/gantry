import type {
  ConversationRoute,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import type { ChannelWiringDeps } from './channel-wiring-types.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { findConversationRoutesForChat } from '../../shared/thread-queue-key.js';

export async function authorizeConversationApprover(input: {
  providerId: string;
  sourceAgentFolder: string;
  decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
  logger: ChannelWiringDeps['logger'];
  lookup: () => Promise<boolean>;
}): Promise<boolean> {
  if (input.decisionPolicy && input.decisionPolicy !== 'same_channel') {
    return false;
  }
  try {
    return await input.lookup();
  } catch (err) {
    input.logger.warn(
      {
        err,
        providerId: input.providerId,
        sourceAgentFolder: input.sourceAgentFolder,
      },
      'Conversation approver lookup failed',
    );
    return false;
  }
}

export function resolveControlApproverContext(input: {
  routes: Record<string, ConversationRoute>;
  providerAccountId?: string;
  conversationJid: string;
  threadId?: string;
  sourceAgentFolder: string;
  agentId?: string;
}): { providerAccountId: string; agentId: string } | undefined {
  const agentId = input.agentId ?? agentIdForFolder(input.sourceAgentFolder);
  let routeCount = 0;
  const providerAccountIds = new Set<string>();
  for (const [, route] of findConversationRoutesForChat(
    input.routes,
    input.conversationJid,
    input.threadId,
  )) {
    if ((route.agentId ?? agentIdForFolder(route.folder)) !== agentId) continue;
    routeCount += 1;
    if (route.providerAccountId)
      providerAccountIds.add(route.providerAccountId);
  }
  if (routeCount === 0) return undefined;
  if (input.providerAccountId) {
    return providerAccountIds.size === 0 ||
      providerAccountIds.has(input.providerAccountId)
      ? { providerAccountId: input.providerAccountId, agentId }
      : undefined;
  }
  return providerAccountIds.size === 1
    ? { providerAccountId: [...providerAccountIds][0]!, agentId }
    : undefined;
}

export function resolveInputControlApproverContext(input: {
  routes: Record<string, ConversationRoute>;
  providerAccountId?: string;
  conversationJid: string;
  threadId?: string;
  sourceAgentFolder: string;
  agentId?: string;
}): { providerAccountId: string; agentId: string } | undefined {
  return input.providerAccountId && input.agentId
    ? { providerAccountId: input.providerAccountId, agentId: input.agentId }
    : resolveControlApproverContext(input);
}
