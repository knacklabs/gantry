import type { ConversationRoute } from '../../domain/types.js';
import { nowIso } from '../../shared/time/datetime.js';
import { findConversationRoutesForChat } from '../../shared/thread-queue-key.js';
import type { MessageAttachmentsDeleted } from '../channel-provider.js';
import type { SlackMessageLike } from './channel-state.js';

export async function routeSlackDeletion(
  event: SlackMessageLike,
  conversationRoutes: Record<string, ConversationRoute>,
  providerAccountIds: readonly string[],
  onMessageAttachmentsDeleted?: (
    event: MessageAttachmentsDeleted,
  ) => Promise<void>,
): Promise<boolean> {
  if (event.subtype !== 'message_deleted') return false;

  const channelId = event.channel?.trim() ?? '';
  const externalMessageId = event.deleted_ts?.trim() ?? '';
  if (!channelId || !externalMessageId) return true;

  const conversationJid = `sl:${channelId}`;
  const threadId = event.previous_message?.thread_ts?.trim() || undefined;
  const channelKey = threadId ?? conversationJid;
  const admitted = providerAccountIds.some(
    (providerAccountId) =>
      findConversationRoutesForChat(
        conversationRoutes,
        conversationJid,
        threadId,
        providerAccountId,
      ).length > 0,
  );
  if (!onMessageAttachmentsDeleted) {
    throw new Error('Slack message attachment deletion callback unavailable');
  }
  await onMessageAttachmentsDeleted({
    providerId: 'slack',
    channelId: channelKey,
    fallbackConversationJid: conversationJid,
    fallbackMatchesThreadedRows: true,
    ...(!admitted
      ? {
          requireStoredMessageMatch: true,
        }
      : {}),
    externalMessageIds: [externalMessageId],
    deletedAt: nowIso(),
  });
  return true;
}
