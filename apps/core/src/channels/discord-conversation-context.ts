import type { NewMessage } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
  HydrationRequestObservation,
} from './channel-provider.js';
import type {
  DiscordChannelInfo,
  DiscordMessageEmbed,
  DiscordMessageCreate,
  DiscordUser,
} from './discord-types.js';

const DISCORD_JID_PREFIX = 'dc:';
const DISCORD_PUBLIC_THREAD_TYPES = new Set([10, 11, 12]);
const DISCORD_THREAD_FIRST_REPLY_LIMIT = 10;
const DISCORD_THREAD_LATEST_REPLY_LIMIT = 39;
const DISCORD_EMBED_TEXT_MAX_BYTES = 1024;
const DISCORD_EMBEDS_MAX_PER_MESSAGE = 4;
const DISCORD_EMBEDS_TOTAL_MAX_BYTES = 4096;

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
    const requests: HydrationRequestObservation[] = [
      {
        role: input.request.threadId ? 'thread' : 'channel',
        limit: latestLimit,
        effectiveBounds: {
          ...(input.request.latestMessage.external_message_id
            ? { cursor: input.request.latestMessage.external_message_id }
            : {}),
        },
        rawMessageCount: rawMessages.length,
        pagination: { kind: 'request_bounded' },
      },
    ];
    const threadRootFetch = input.request.threadId
      ? await fetchDiscordThreadRootMessage(input)
      : null;
    if (threadRootFetch) requests.push(threadRootFetch.observation);
    const threadRootMessage = threadRootFetch?.message ?? null;
    const firstReplyLimit =
      input.request.threadId && limit > 0
        ? Math.min(
            DISCORD_THREAD_FIRST_REPLY_LIMIT,
            Math.max(0, limit - latestLimit - (threadRootMessage ? 1 : 0)),
          )
        : 0;
    const firstReplyFetch =
      firstReplyLimit > 0
        ? await fetchDiscordThreadFirstReplies(input, firstReplyLimit)
        : null;
    if (firstReplyFetch?.observation) {
      requests.push(firstReplyFetch.observation);
    }
    const firstReplyMessages = firstReplyFetch?.messages ?? [];
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
    return {
      providerId: 'discord',
      attempted: true,
      messages,
      ...(firstReplyFetch?.failed
        ? {}
        : {
            coverage: {
              requestedLatestMessage: {
                ...(input.request.latestMessage.external_message_id !==
                undefined
                  ? {
                      externalMessageId:
                        input.request.latestMessage.external_message_id,
                    }
                  : {}),
                timestamp: input.request.latestMessage.timestamp,
              },
              scope: input.request.threadId ? 'thread' : 'channel',
              requests,
              completeness: { kind: 'request_bounded' },
              deliveredMessageCount: messages.length,
              threadRoot: input.request.threadId
                ? messages.some(
                    (message) =>
                      message.external_message_id === input.request.threadId,
                  )
                  ? 'included'
                  : 'missing'
                : 'not_applicable',
            },
          }),
    };
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
): Promise<{
  messages: DiscordMessageCreate[];
  observation?: HydrationRequestObservation;
  failed: boolean;
}> {
  const threadId = input.request.threadId!;
  try {
    const query = new URLSearchParams({
      after: threadId,
      limit: String(limit),
    });
    const messages = await input.requestJson<DiscordMessageCreate[]>(
      `/channels/${encodeURIComponent(threadId)}/messages?${query.toString()}`,
      { method: 'GET', headers: input.headers(input.botToken) },
      'Discord first thread replies request failed',
    );
    return {
      messages,
      failed: false,
      observation: {
        role: 'thread_first_replies',
        limit,
        effectiveBounds: { cursor: threadId },
        rawMessageCount: messages.length,
        pagination: { kind: 'request_bounded' },
      },
    };
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
    return {
      messages: [],
      failed: true,
    };
  }
}

async function fetchDiscordThreadRootMessage(input: {
  request: ConversationContextHydrationRequest;
  botToken: string;
  headers(token: string): Record<string, string>;
  requestJson: DiscordContextRequestJson;
}): Promise<{
  message: DiscordMessageCreate | null;
  observation: HydrationRequestObservation;
}> {
  const threadId = input.request.threadId!;
  try {
    const message = await input.requestJson<DiscordMessageCreate>(
      `/channels/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(threadId)}`,
      { method: 'GET', headers: input.headers(input.botToken) },
      'Discord thread root message request failed',
    );
    return {
      message,
      observation: {
        role: 'thread_root',
        limit: 1,
        effectiveBounds: {},
        rawMessageCount: 1,
        pagination: { kind: 'request_bounded' },
      },
    };
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
    return {
      message: null,
      observation: {
        role: 'thread_root',
        limit: 1,
        effectiveBounds: {},
        rawMessageCount: 0,
        pagination: { kind: 'request_bounded' },
      },
    };
  }
}

export async function resolveDiscordConversationContext(input: {
  channelId: string;
  botToken: string;
  cache: DiscordConversationContextCache;
  headers(token: string): Record<string, string>;
  requestJson: DiscordContextRequestJson;
  failClosed?: boolean;
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
    if (input.failClosed) throw err;
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
    if (!message.id || isDiscordEphemeralMessage(message)) continue;
    const content = discordMessageContent(message);
    const attachments = discordMessageAttachments(
      message,
      input.conversationJid,
    );
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
  conversationJid?: string,
): NonNullable<NewMessage['attachments']> {
  if (isDiscordEphemeralMessage(message)) return [];
  const conversationChannelId = conversationJid
    ? discordChannelIdFromJid(conversationJid)
    : null;
  return (message.attachments || [])
    .filter((attachment) => attachment.ephemeral !== true)
    .map((attachment) => ({
      id: attachment.id ? `discord-attachment:${attachment.id}` : undefined,
      kind: attachment.content_type?.startsWith('image/')
        ? 'image'
        : attachment.content_type?.startsWith('audio/')
          ? 'audio'
          : 'file',
      contentType: attachment.content_type,
      sizeBytes:
        typeof attachment.size === 'number' && Number.isFinite(attachment.size)
          ? attachment.size
          : undefined,
      externalId: attachment.id,
      file_name: attachment.filename,
      provider_fetch:
        attachment.id && message.channel_id && message.id
          ? {
              provider: 'discord',
              kind: 'attachment_id',
              id: attachment.id,
              channelId: message.channel_id,
              messageId: message.id,
              ...(conversationChannelId &&
              conversationChannelId !== message.channel_id
                ? { parentChannelId: conversationChannelId }
                : {}),
            }
          : undefined,
    }));
}

export function discordMessageContent(message: DiscordMessageCreate): string {
  // The native body is forwarded VERBATIM (whitespace-sensitive content like
  // indented code must survive); trimming is only used to decide emptiness.
  const raw = message.content ?? '';
  const body = raw.trim() ? raw : '';
  // Aggregate embed budget: at most 4 embeds share a combined byte cap so
  // multi-embed messages cannot multiply the per-embed bound.
  let remaining = DISCORD_EMBEDS_TOTAL_MAX_BYTES;
  const folded: string[] = [];
  for (const embed of (message.embeds ?? []).slice(
    0,
    DISCORD_EMBEDS_MAX_PER_MESSAGE,
  )) {
    if (remaining <= 0) break;
    const text = foldEmbed(embed);
    if (!text) continue;
    if (folded.length > 0) remaining -= 2; // '\n\n' separator
    if (remaining <= 0) break;
    const bounded =
      Buffer.byteLength(text, 'utf8') > remaining
        ? `${Buffer.from(text, 'utf8')
            .subarray(0, Math.max(0, remaining - 3))
            .toString('utf8')
            .replace(/\uFFFD+$/u, '')}…`
        : text;
    remaining -= Buffer.byteLength(bounded, 'utf8');
    folded.push(bounded);
  }
  if (folded.length === 0) return body;
  return [body, ...folded].filter(Boolean).join('\n\n');
}

function foldEmbed(embed: DiscordMessageEmbed): string {
  const parts = [
    embed.title ? `Title: ${embed.title}` : '',
    embed.description ? `Description: ${embed.description}` : '',
    embed.url ? `URL: ${embed.url}` : '',
    ...(embed.fields ?? []).flatMap((field) => [
      field.name ? `Field: ${field.name}` : '',
      field.value ? `Value: ${field.value}` : '',
    ]),
    embed.author?.name ? `Author: ${embed.author.name}` : '',
    embed.footer?.text ? `Footer: ${embed.footer.text}` : '',
    embed.image?.description ? `Image: ${embed.image.description}` : '',
    embed.thumbnail?.description
      ? `Thumbnail: ${embed.thumbnail.description}`
      : '',
    embed.video?.description ? `Video: ${embed.video.description}` : '',
  ].filter(Boolean);
  return truncateUtf8(parts.join('\n'), DISCORD_EMBED_TEXT_MAX_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '...[truncated]';
  const contentBytes = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > contentBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${suffix}`;
}

export function isDiscordEphemeralMessage(
  message: DiscordMessageCreate,
): boolean {
  return ((message.flags ?? 0) & 64) !== 0;
}

export function isDiscordDurableIngressMessage(
  message: DiscordMessageCreate,
): message is DiscordMessageCreate & { id: string; channel_id: string } {
  return Boolean(
    message.id && message.channel_id && !isDiscordEphemeralMessage(message),
  );
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
