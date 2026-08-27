import type { NewMessage } from '../../domain/types.js';
import type { ChannelOpts } from '../channel-provider.js';
import { applyInboundConversationIdentity } from '../inbound-conversation-identity.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
  HydrationRequestObservation,
} from '../channel-provider.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  teamsConversationIdFromJid,
  type TeamsContextMessage,
  type TeamsSdkClient,
} from './types.js';

export async function hydrateTeamsConversationContext(
  request: ConversationContextHydrationRequest,
  sdkClient: TeamsSdkClient,
  botUserId: string | null,
): Promise<ConversationContextHydrationResult> {
  const conversationId = teamsConversationIdFromJid(request.conversationJid);
  if (!conversationId) {
    return {
      providerId: 'teams',
      attempted: false,
      skipped: true,
      reason: 'invalid_conversation',
    };
  }
  const limit = request.threadId
    ? request.limits.threadMessages
    : request.limits.channelMessages;
  if (limit <= 0) {
    return {
      providerId: 'teams',
      attempted: false,
      skipped: true,
      reason: 'limit_exhausted',
      messages: [],
    };
  }

  if (request.threadId) {
    if (!sdkClient.getChannelMessage && !sdkClient.listChannelMessageReplies) {
      return skippedTeamsHydration(request);
    }
  } else if (!sdkClient.listChannelMessages) {
    return skippedTeamsHydration(request);
  }

  try {
    const fetch = request.threadId
      ? await hydrateTeamsThreadMessages({
          request,
          conversationId,
          limit,
          sdkClient,
        })
      : await hydrateTeamsChannelMessages({
          request,
          conversationId,
          limit,
          sdkClient,
        });
    const messages = normalizeTeamsContextMessages(
      request.conversationJid,
      request.threadId || undefined,
      fetch.messages,
      limit,
      botUserId,
    );
    logger.debug(
      {
        providerId: 'teams',
        conversationJid: request.conversationJid,
        threadId: request.threadId,
        attempted: true,
        hydratedMessages: messages.length,
      },
      'Teams context hydration completed',
    );
    return {
      providerId: 'teams',
      attempted: true,
      messages,
      coverage: {
        requestedLatestMessage: {
          ...(request.latestMessage.external_message_id !== undefined
            ? {
                externalMessageId: request.latestMessage.external_message_id,
              }
            : {}),
          timestamp: request.latestMessage.timestamp,
        },
        scope: request.threadId ? 'thread' : 'channel',
        requests: fetch.requests,
        completeness: { kind: 'request_bounded' },
        deliveredMessageCount: messages.length,
        threadRoot: request.threadId
          ? messages.some(
              (message) => message.external_message_id === request.threadId,
            )
            ? 'included'
            : 'missing'
          : 'not_applicable',
      },
    };
  } catch (err) {
    logger.debug(
      {
        providerId: 'teams',
        conversationJid: request.conversationJid,
        threadId: request.threadId,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      'Teams context hydration failed',
    );
    return {
      providerId: 'teams',
      attempted: true,
      failed: true,
      reason: 'provider_error',
      messages: [],
    };
  }
}

async function hydrateTeamsChannelMessages(input: {
  request: ConversationContextHydrationRequest;
  conversationId: string;
  limit: number;
  sdkClient: TeamsSdkClient;
}): Promise<{
  messages: TeamsContextMessage[];
  requests: HydrationRequestObservation[];
}> {
  const messages = await input.sdkClient.listChannelMessages!({
    conversationId: input.conversationId,
    beforeMessageId: input.request.latestMessage.external_message_id,
    limit: input.limit,
  });
  return {
    messages,
    requests: [
      {
        role: 'channel',
        limit: input.limit,
        effectiveBounds: {
          ...(input.request.latestMessage.external_message_id
            ? { cursor: input.request.latestMessage.external_message_id }
            : {}),
        },
        rawMessageCount: messages.length,
        pagination: { kind: 'request_bounded' },
      },
    ],
  };
}

async function hydrateTeamsThreadMessages(input: {
  request: ConversationContextHydrationRequest;
  conversationId: string;
  limit: number;
  sdkClient: TeamsSdkClient;
}): Promise<{
  messages: TeamsContextMessage[];
  requests: HydrationRequestObservation[];
}> {
  const rootFetch = input.sdkClient.getChannelMessage
    ? await fetchTeamsThreadRootMessage(input)
    : null;
  const rootMessage = rootFetch?.message ?? null;
  const requests = rootFetch ? [rootFetch.observation] : [];
  const replyLimit = Math.max(0, input.limit - (rootMessage ? 1 : 0));
  if (replyLimit <= 0 || !input.sdkClient.listChannelMessageReplies) {
    return { messages: rootMessage ? [rootMessage] : [], requests };
  }
  const replies = await input.sdkClient.listChannelMessageReplies({
    conversationId: input.conversationId,
    messageId: input.request.threadId!,
    beforeMessageId: input.request.latestMessage.external_message_id,
    limit: replyLimit,
  });
  requests.push({
    role: 'thread',
    limit: replyLimit,
    effectiveBounds: {
      ...(input.request.latestMessage.external_message_id
        ? { cursor: input.request.latestMessage.external_message_id }
        : {}),
    },
    rawMessageCount: replies.length,
    pagination: { kind: 'request_bounded' },
  });
  return {
    messages: rootMessage ? [rootMessage, ...replies] : replies,
    requests,
  };
}

async function fetchTeamsThreadRootMessage(input: {
  request: ConversationContextHydrationRequest;
  conversationId: string;
  sdkClient: TeamsSdkClient;
}): Promise<{
  message: TeamsContextMessage | null;
  observation: HydrationRequestObservation;
}> {
  try {
    const message = await input.sdkClient.getChannelMessage!({
      conversationId: input.conversationId,
      messageId: input.request.threadId!,
    });
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
        providerId: 'teams',
        conversationJid: input.request.conversationJid,
        threadId: input.request.threadId,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      'Teams thread root message hydration failed',
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

function skippedTeamsHydration(
  request: ConversationContextHydrationRequest,
): ConversationContextHydrationResult {
  logger.debug(
    {
      providerId: 'teams',
      conversationJid: request.conversationJid,
      threadId: request.threadId,
      attempted: false,
      skipped: true,
      reason: 'unsupported_sdk',
    },
    'Teams context hydration skipped',
  );
  return {
    providerId: 'teams',
    attempted: false,
    skipped: true,
    reason: 'unsupported_sdk',
    messages: [],
  };
}

function normalizeTeamsContextMessages(
  jid: string,
  requestedThreadId: string | undefined,
  rawMessages: TeamsContextMessage[],
  limit: number,
  botUserId: string | null,
): NewMessage[] {
  const byExternalId = new Map<string, NewMessage>();
  for (const message of rawMessages) {
    if (byExternalId.size >= limit) break;
    if (!message.id) continue;
    const content = message.text?.trim() || '';
    const attachments = teamsMessageAttachments(message);
    if (!content && attachments.length === 0) continue;
    const sender = message.senderId || message.from?.id || 'unknown';
    const isSelfMessage = isTeamsSelfMessage(sender, botUserId);
    const threadId = message.threadId || requestedThreadId;
    byExternalId.set(message.id, {
      id: message.id,
      chat_jid: jid,
      provider: 'teams',
      sender,
      sender_name: message.senderName || message.from?.name || sender,
      content,
      timestamp: message.timestamp || nowIso(),
      is_from_me: isSelfMessage,
      is_bot_message: isSelfMessage,
      ...(isSelfMessage ? { delivery_status: 'sent' } : {}),
      thread_id: threadId,
      reply_to_message_id:
        message.replyToId ||
        (threadId && threadId !== message.id ? threadId : undefined),
      external_message_id: message.id,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }
  return Array.from(byExternalId.values()).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
}

function isTeamsSelfMessage(sender: string, botUserId: string | null): boolean {
  const normalizedBotUserId = botUserId?.trim().toLowerCase();
  if (!normalizedBotUserId) return false;
  const normalizedSender = sender.trim().toLowerCase();
  return (
    normalizedSender === normalizedBotUserId ||
    normalizedSender === `28:${normalizedBotUserId}`
  );
}

export function teamsMessageAttachments(
  message: TeamsContextMessage,
): NonNullable<NewMessage['attachments']> {
  return (message.attachments || []).map((attachment) => ({
    id: attachment.id ? `teams-attachment:${attachment.id}` : undefined,
    kind: attachment.contentType?.startsWith('image/') ? 'image' : 'file',
    contentType: attachment.contentType,
    sizeBytes:
      typeof attachment.sizeBytes === 'number' &&
      Number.isFinite(attachment.sizeBytes)
        ? attachment.sizeBytes
        : undefined,
    externalId: attachment.id,
  }));
}

/**
 * LAT-4A: resolve the inbound conversation identity for a Teams message,
 * writing standalone metadata only when no message envelope will follow.
 * Lives here rather than in teams.ts to keep that file inside its size budget.
 */
export async function resolveTeamsInboundIdentity(input: {
  opts: Pick<
    ChannelOpts,
    'conversationRoutes' | 'onChatMetadata' | 'providerAccountId'
  >;
  jid: string;
  timestamp: string;
  conversationName?: string;
  threadId?: string | null;
  isGroup: boolean;
}): Promise<Pick<NewMessage, 'name' | 'isGroup'>> {
  return applyInboundConversationIdentity({
    conversationRoutes: input.opts.conversationRoutes(),
    chatJid: input.jid,
    threadId: input.threadId,
    providerAccountId: input.opts.providerAccountId,
    name: input.conversationName,
    isGroup: input.isGroup,
    writeMetadata: () =>
      input.opts.onChatMetadata(
        input.jid,
        input.timestamp,
        input.conversationName,
        'teams',
        input.isGroup,
        { providerAccountId: input.opts.providerAccountId },
      ),
  });
}
