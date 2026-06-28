import type { NewMessage } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
} from './channel-provider.js';
import type {
  DiscordChannelInfo,
  DiscordMessageCreate,
  DiscordUser,
} from './discord-types.js';

const DISCORD_JID_PREFIX = 'dc:';
const DISCORD_PUBLIC_THREAD_TYPES = new Set([10, 11, 12]);
const DISCORD_THREAD_FIRST_REPLY_LIMIT = 10;
const DISCORD_THREAD_LATEST_REPLY_LIMIT = 39;

export type DiscordConversationContextCache = Map<
  string,
  { conversationJid: string; threadId?: string }
>;

export type DiscordContextRequestJson = <T>(
  path: string,
  init: RequestInit,
  errorMessage: string,
  parseJson?: boolean,
) => Promise<T>;

export async function hydrateDiscordConversationContext(input: {
  request: ConversationContextHydrationRequest;
  botToken: string;
  botUserId: string | null;
  cache: DiscordConversationContextCache;
  headers(token: string): Record<string, string>;
  requestJson: DiscordContextRequestJson;
}): Promise<ConversationContextHydrationResult> {
  const requestedChannelId = discordChannelIdFromJid(
    input.request.conversationJid,
  );
  if (!requestedChannelId) {
    return {
      providerId: 'discord',
      attempted: false,
      skipped: true,
      reason: 'invalid_conversation',
    };
  }
  const targetChannelId = input.request.threadId || requestedChannelId;
  const limit = input.request.threadId
    ? input.request.limits.threadMessages
    : input.request.limits.channelMessages;
  if (limit <= 0) {
    return {
      providerId: 'discord',
      attempted: false,
      skipped: true,
      reason: 'limit_exhausted',
      messages: [],
    };
  }

  try {
    const latestLimit = input.request.threadId
      ? Math.min(limit, DISCORD_THREAD_LATEST_REPLY_LIMIT)
      : limit;
    const query = new URLSearchParams({ limit: String(latestLimit) });
    if (input.request.latestMessage.external_message_id) {
      query.set('before', input.request.latestMessage.external_message_id);
    }
    const rawMessages = await input.requestJson<DiscordMessageCreate[]>(
      `/channels/${encodeURIComponent(targetChannelId)}/messages?${query.toString()}`,
      { method: 'GET', headers: input.headers(input.botToken) },
      'Discord message history request failed',
    );
    const threadRootMessage = input.request.threadId
      ? await fetchDiscordThreadRootMessage(input)
      : null;
    const firstReplyLimit =
      input.request.threadId && limit > 0
        ? Math.min(
            DISCORD_THREAD_FIRST_REPLY_LIMIT,
            Math.max(0, limit - latestLimit - (threadRootMessage ? 1 : 0)),
          )
        : 0;
    const firstReplyMessages =
      firstReplyLimit > 0
        ? await fetchDiscordThreadFirstReplies(input, firstReplyLimit)
        : [];
    const context = await resolveDiscordConversationContext({
      channelId: input.request.threadId ? targetChannelId : requestedChannelId,
      botToken: input.botToken,
      cache: input.cache,
      headers: input.headers,
      requestJson: input.requestJson,
    });
    const fallbackThreadId =
      input.request.threadId || context.threadId || undefined;
    const fallbackConversationJid =
      input.request.threadId && !context.threadId
        ? input.request.conversationJid
        : context.conversationJid;
    const messages = normalizeDiscordContextMessages({
      rawMessages: input.request.threadId
        ? [
            ...(threadRootMessage ? [threadRootMessage] : []),
            ...firstReplyMessages,
            ...rawMessages,
          ]
        : rawMessages,
      conversationJid: fallbackConversationJid,
      threadId: fallbackThreadId,
      limit,
      botUserId: input.botUserId,
    });
    logger.debug(
      {
        providerId: 'discord',
        conversationJid: fallbackConversationJid,
        threadId: fallbackThreadId,
        attempted: true,
        hydratedMessages: messages.length,
      },
      'Discord context hydration completed',
    );
    return { providerId: 'discord', attempted: true, messages };
  } catch (err) {
    logger.debug(
      {
        providerId: 'discord',
        conversationJid: input.request.conversationJid,
        threadId: input.request.threadId,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      'Discord context hydration failed',
    );
    return {
      providerId: 'discord',
      attempted: true,
      failed: true,
      reason: 'provider_error',
      messages: [],
    };
  }
}

async function fetchDiscordThreadFirstReplies(
  input: {
    request: ConversationContextHydrationRequest;
    botToken: string;
    headers(token: string): Record<string, string>;
    requestJson: DiscordContextRequestJson;
  },
  limit: number,
): Promise<DiscordMessageCreate[]> {
  const threadId = input.request.threadId;
  if (!threadId || limit <= 0) return [];
  try {
    const query = new URLSearchParams({
      after: threadId,
      limit: String(limit),
    });
    return await input.requestJson<DiscordMessageCreate[]>(
      `/channels/${encodeURIComponent(threadId)}/messages?${query.toString()}`,
      { method: 'GET', headers: input.headers(input.botToken) },
      'Discord first thread replies request failed',
    );
  } catch (err) {
    logger.debug(
      {
        providerId: 'discord',
        conversationJid: input.request.conversationJid,
        threadId,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      'Discord first thread replies hydration failed',
    );
    return [];
  }
}

async function fetchDiscordThreadRootMessage(input: {
  request: ConversationContextHydrationRequest;
  botToken: string;
  headers(token: string): Record<string, string>;
  requestJson: DiscordContextRequestJson;
}): Promise<DiscordMessageCreate | null> {
  const threadId = input.request.threadId;
  if (!threadId) return null;
  try {
    return await input.requestJson<DiscordMessageCreate>(
      `/channels/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(threadId)}`,
      { method: 'GET', headers: input.headers(input.botToken) },
      'Discord thread root message request failed',
    );
  } catch (err) {
    logger.debug(
      {
        providerId: 'discord',
        conversationJid: input.request.conversationJid,
        threadId,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      'Discord thread root message hydration failed',
    );
    return null;
  }
}

export async function resolveDiscordConversationContext(input: {
  channelId: string;
  botToken: string;
  cache: DiscordConversationContextCache;
  headers(token: string): Record<string, string>;
  requestJson: DiscordContextRequestJson;
}): Promise<{ conversationJid: string; threadId?: string }> {
  const cached = input.cache.get(input.channelId);
  if (cached) return cached;
  const fallback = {
    conversationJid: `${DISCORD_JID_PREFIX}${input.channelId}`,
  };
  try {
    const info = await input.requestJson<DiscordChannelInfo>(
      `/channels/${encodeURIComponent(input.channelId)}`,
      { method: 'GET', headers: input.headers(input.botToken) },
      'Discord channel lookup failed',
    );
    const context =
      info.parent_id && DISCORD_PUBLIC_THREAD_TYPES.has(info.type ?? -1)
        ? {
            conversationJid: `${DISCORD_JID_PREFIX}${info.parent_id}`,
            threadId: input.channelId,
          }
        : fallback;
    input.cache.set(input.channelId, context);
    return context;
  } catch (err) {
    logger.debug(
      {
        providerId: 'discord',
        channelId: input.channelId,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      'Discord thread parent lookup failed',
    );
    return fallback;
  }
}

function normalizeDiscordContextMessages(input: {
  rawMessages: DiscordMessageCreate[];
  conversationJid: string;
  threadId: string | undefined;
  limit: number;
  botUserId: string | null;
}): NewMessage[] {
  const byExternalId = new Map<string, NewMessage>();
  for (const message of input.rawMessages) {
    if (byExternalId.size >= input.limit) break;
    if (!message.id) continue;
    const content = message.content?.trim() || '';
    const attachments = discordMessageAttachments(message);
    if (!content && attachments.length === 0) continue;
    const author = message.author || message.member?.user;
    const sender = author?.id || 'unknown';
    const isSelfMessage = input.botUserId ? sender === input.botUserId : false;
    byExternalId.set(message.id, {
      id: message.id,
      chat_jid: input.conversationJid,
      provider: 'discord',
      sender,
      sender_name: message.member?.nick || userName(author),
      content,
      timestamp: message.timestamp || new Date().toISOString(),
      is_from_me: isSelfMessage,
      is_bot_message: isSelfMessage,
      ...(isSelfMessage ? { delivery_status: 'sent' } : {}),
      thread_id: input.threadId,
      external_message_id: message.id,
      reply_to_message_id: message.referenced_message?.id,
      reply_to_message_content: message.referenced_message?.content,
      reply_to_sender_name: userName(message.referenced_message?.author, ''),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }
  return Array.from(byExternalId.values()).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
}

export function discordMessageAttachments(
  message: DiscordMessageCreate,
): NonNullable<NewMessage['attachments']> {
  return (message.attachments || []).map((attachment) => ({
    id: attachment.id ? `discord-attachment:${attachment.id}` : undefined,
    kind: attachment.content_type?.startsWith('image/') ? 'image' : 'file',
    contentType: attachment.content_type,
    sizeBytes:
      typeof attachment.size === 'number' && Number.isFinite(attachment.size)
        ? attachment.size
        : undefined,
    externalId: attachment.id,
  }));
}

function userName(user: DiscordUser | undefined, fallback = 'unknown'): string {
  return user?.username || user?.id || fallback;
}

function discordChannelIdFromJid(jid: string): string | null {
  const trimmed = jid.trim();
  const normalized = trimmed.startsWith(DISCORD_JID_PREFIX)
    ? trimmed
    : `${DISCORD_JID_PREFIX}${trimmed}`;
  return normalized ? normalized.slice(DISCORD_JID_PREFIX.length) : null;
}
