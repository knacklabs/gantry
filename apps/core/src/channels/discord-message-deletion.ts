import { nowIso } from '../shared/time/datetime.js';
import type { MessageAttachmentsDeleted } from './channel-provider.js';
import {
  resolveDiscordConversationContext,
  type DiscordContextRequestJson,
  type DiscordConversationContextCache,
} from './discord-conversation-context.js';
import { discordHeaders } from './discord-http-helpers.js';
import type {
  DiscordGatewayPayload,
  DiscordMessageDelete,
  DiscordMessageDeleteBulk,
} from './discord-types.js';

export async function routeDiscordDeletion(
  payload: Pick<DiscordGatewayPayload, 't' | 'd'>,
  botToken: string,
  cache: DiscordConversationContextCache,
  requestJson: DiscordContextRequestJson,
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
  if (!onMessageAttachmentsDeleted) {
    throw new Error('Discord message attachment deletion callback unavailable');
  }
  const context = await resolveDiscordConversationContext({
    channelId: event.channel_id,
    botToken,
    cache,
    headers: discordHeaders,
    requestJson,
    failClosed: true,
  });
  await onMessageAttachmentsDeleted({
    providerId: 'discord',
    conversationJid: context.conversationJid,
    ...(context.threadId ? { threadId: context.threadId } : {}),
    externalMessageIds,
    deletedAt: nowIso(),
  });
  return true;
}
