import type {
  ConversationRoute,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import type { AppId } from '../../domain/app/app.js';
import type { PrincipalRef } from '../../domain/identity/principal-ref.js';
import type {
  ConversationRepository,
  ProviderAccountRepository,
} from '../../domain/ports/repositories.js';
import {
  ConversationAdministrationService,
  type ConversationMembershipValidator,
} from '../../application/provider-conversations/conversation-administration-service.js';
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

export function createControlApproverAuthorizer(input: {
  appId: AppId;
  routes: () => Record<string, ConversationRoute>;
  repositories: () => {
    providerAccounts: ProviderAccountRepository;
    conversations: ConversationRepository;
  };
  membershipValidator: () => ConversationMembershipValidator;
  logger: ChannelWiringDeps['logger'];
}): (request: {
  providerId: string;
  providerAccountId?: string;
  conversationJid: string;
  threadId?: string;
  userId: string;
  sourceAgentFolder: string;
  agentId?: string;
  decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
}) => Promise<boolean> {
  return (request) =>
    Promise.resolve(
      resolveInputControlApproverContext({
        routes: input.routes(),
        ...request,
      }),
    ).then((context) => {
      if (!context) return false;
      return authorizeConversationApprover({
        ...request,
        logger: input.logger,
        lookup: async () =>
          new ConversationAdministrationService(
            input.repositories(),
            input.membershipValidator(),
          ).isControlApproverAllowed({
            appId: input.appId,
            providerId: request.providerId as never,
            providerAccountId: context.providerAccountId as never,
            agentId: context.agentId as never,
            conversationJid: request.conversationJid,
            threadId: request.threadId,
            userId: request.userId,
          }),
      });
    });
}

/** Resolves a verified channel approver to the durable human principal. */
export function createControlApproverPrincipalResolver(input: {
  appId: AppId;
  routes: () => Record<string, ConversationRoute>;
  providerIdForJid: (jid: string, fallback: string) => string | undefined;
  repositories: () => {
    providerAccounts: ProviderAccountRepository;
    conversations: ConversationRepository;
  };
  membershipValidator: () => ConversationMembershipValidator;
  logger: ChannelWiringDeps['logger'];
}): (request: {
  providerAccountId?: string;
  conversationJid: string;
  threadId?: string;
  userId: string;
  sourceAgentFolder: string;
  agentId?: string;
  decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
}) => Promise<PrincipalRef | null> {
  return async (request) => {
    const providerId = input.providerIdForJid(request.conversationJid, '');
    if (!providerId) return null;
    const context = resolveControlApproverContext({
      ...request,
      routes: input.routes(),
    });
    if (!context) return null;
    try {
      return await new ConversationAdministrationService(
        input.repositories(),
        input.membershipValidator(),
      ).resolveControlApproverPrincipal({
        appId: input.appId,
        providerId: providerId as never,
        providerAccountId: context.providerAccountId as never,
        agentId: context.agentId as never,
        conversationJid: request.conversationJid,
        threadId: request.threadId,
        userId: request.userId,
      });
    } catch (err) {
      input.logger.warn(
        {
          err,
          providerId,
          sourceAgentFolder: request.sourceAgentFolder,
        },
        'Conversation approver identity lookup failed',
      );
      return null;
    }
  };
}
