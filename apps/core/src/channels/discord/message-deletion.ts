import { nowIso } from '../../shared/time/datetime.js';
import {
  findConversationRoutesForChat,
  parseAgentThreadQueueKey,
} from '../../shared/thread-queue-key.js';
import type { ConversationRoute } from '../../domain/types.js';
import type { MessageAttachmentsDeleted } from '../channel-provider.js';
import type { DiscordConversationContextCache } from './conversation-context.js';
import type {
  DiscordGatewayPayload,
  DiscordMessageDelete,
  DiscordMessageDeleteBulk,
} from './types.js';

export async function routeDiscordDeletion(
  payload: Pick<DiscordGatewayPayload, 't' | 'd'>,
  cache: DiscordConversationContextCache,
  conversationRoutes: Record<string, ConversationRoute>,
  providerAccountIds: readonly string[],
  onMessageAttachmentsDeleted?: (
    event: MessageAttachmentsDeleted,
  ) => Promise<void>,
): Promise<boolean> {
  if (payload.t !== 'MESSAGE_DELETE' && payload.t !== 'MESSAGE_DELETE_BULK') {
    return false;
  }
  const event = payload.d as DiscordMessageDelete | DiscordMessageDeleteBulk;
  const messageIds =
    payload.t === 'MESSAGE_DELETE'
      ? [(event as DiscordMessageDelete).id]
      : (event as DiscordMessageDeleteBulk).ids;
  const externalMessageIds = [...new Set(messageIds ?? [])]
    .map((id) => id?.trim() ?? '')
    .filter(Boolean)
    .sort();
  if (!event.channel_id?.trim() || externalMessageIds.length === 0) return true;
  const channelKey = admittedDeletionChannelKey(
    conversationRoutes,
    event.channel_id,
    providerAccountIds,
    cache.get(event.channel_id),
  );
  if (!onMessageAttachmentsDeleted) {
    throw new Error('Discord message attachment deletion callback unavailable');
  }
  await onMessageAttachmentsDeleted({
    providerId: 'discord',
    providerAccountIds,
    channelId: channelKey ?? event.channel_id,
    ...(!channelKey
      ? {
          fallbackConversationJid: `dc:${event.channel_id}`,
          requireStoredMessageMatch: true,
        }
      : {}),
    externalMessageIds,
    deletedAt: nowIso(),
  });
  return true;
}

function admittedDeletionChannelKey(
  routes: Record<string, ConversationRoute>,
  channelId: string,
  providerAccountIds: readonly string[],
  cachedContext?: { conversationJid: string; threadId?: string },
): string | undefined {
  const scopes = cachedContext
    ? [cachedContext]
    : [
        { conversationJid: `dc:${channelId}` },
        ...Object.keys(routes).flatMap((key) => {
          const parsed = parseAgentThreadQueueKey(key);
          return parsed.threadId === channelId
            ? [{ conversationJid: parsed.chatJid, threadId: channelId }]
            : [];
        }),
      ];
  const admitted = scopes.find((scope) =>
    providerAccountIds.some(
      (providerAccountId) =>
        findConversationRoutesForChat(
          routes,
          scope.conversationJid,
          scope.threadId,
          providerAccountId,
        ).length > 0,
    ),
  );
  return admitted?.threadId ?? admitted?.conversationJid;
}
