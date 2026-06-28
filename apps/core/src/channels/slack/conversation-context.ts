import type { App } from '@slack/bolt';

import type { NewMessage } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
} from '../channel-provider.js';
import type { SlackMessageLike } from './channel-state.js';

interface SlackHydratedMessagesResponse {
  ok?: boolean;
  error?: string;
  messages?: SlackMessageLike[];
  has_more?: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
}

type SlackHydratedFile = NonNullable<SlackMessageLike['files']>[number] & {
  size?: number;
};

const THREAD_LONG_FIRST_REPLIES = 10;
const THREAD_TAIL_INITIAL_LOOKBACK_SECONDS = 60 * 60;
const THREAD_TAIL_MAX_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
const THREAD_TAIL_MIN_LOOKBACK_SECONDS = 1;
const THREAD_TAIL_WINDOW_ATTEMPTS = 5;

export interface SlackConversationContextDeps {
  app: App | null;
  botUserId: string | null;
  parseJid(jid: string): { channelId: string } | null;
  resolveUserName(userId: string | undefined): Promise<string>;
}

export async function hydrateSlackConversationContext(
  request: ConversationContextHydrationRequest,
  deps: SlackConversationContextDeps,
): Promise<ConversationContextHydrationResult> {
  const parsed = deps.parseJid(request.conversationJid);
  if (!parsed) {
    return {
      providerId: 'slack',
      attempted: false,
      skipped: true,
      reason: 'invalid_conversation',
    };
  }
  if (!deps.app) {
    return {
      providerId: 'slack',
      attempted: false,
      skipped: true,
      reason: 'not_connected',
    };
  }

  const limit = request.threadId
    ? request.limits.threadMessages
    : request.limits.channelMessages;
  if (limit <= 0) {
    return {
      providerId: 'slack',
      attempted: false,
      skipped: true,
      reason: 'limit_exhausted',
      messages: [],
    };
  }

  try {
    const response = await fetchSlackMessages(
      request,
      deps.app,
      parsed.channelId,
      limit,
    );
    if (response.ok === false) {
      return failedSlackHydration(request, response.error || 'provider_error');
    }

    const messages = await normalizeHydratedSlackMessages({
      jid: request.conversationJid,
      requestedThreadId: request.threadId || undefined,
      rawMessages: response.messages || [],
      limit,
      botUserId: deps.botUserId,
      resolveUserName: deps.resolveUserName,
    });
    logger.debug(
      {
        providerId: 'slack',
        conversationJid: request.conversationJid,
        threadId: request.threadId,
        attempted: true,
        hydratedMessages: messages.length,
      },
      'Slack context hydration completed',
    );
    return { providerId: 'slack', attempted: true, messages };
  } catch (err) {
    logger.debug(
      {
        providerId: 'slack',
        conversationJid: request.conversationJid,
        threadId: request.threadId,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      'Slack context hydration failed',
    );
    return {
      providerId: 'slack',
      attempted: true,
      failed: true,
      reason: 'provider_error',
      messages: [],
    };
  }
}

async function fetchSlackMessages(
  request: ConversationContextHydrationRequest,
  app: App,
  channel: string,
  limit: number,
): Promise<SlackHydratedMessagesResponse> {
  const latest = slackLatestCursor(request.latestMessage);
  if (request.threadId) {
    return fetchSlackThreadMessages(request, app, channel, limit, latest);
  }
  return (await app.client.conversations.history({
    channel,
    latest,
    inclusive: false,
    limit,
  })) as SlackHydratedMessagesResponse;
}

async function fetchSlackThreadMessages(
  request: ConversationContextHydrationRequest,
  app: App,
  channel: string,
  limit: number,
  latest: string | undefined,
): Promise<SlackHydratedMessagesResponse> {
  const first = (await app.client.conversations.replies({
    channel,
    ts: request.threadId!,
    latest,
    inclusive: false,
    limit,
  })) as SlackHydratedMessagesResponse;
  if (first.ok === false) return first;

  const messages = [...(first.messages || [])];
  const cursor = first.response_metadata?.next_cursor?.trim();
  let tailResponse: SlackHydratedMessagesResponse | null = null;
  const tailLimit = slackThreadTailFetchLimit(limit);
  if (cursor && tailLimit > 0) {
    tailResponse = await fetchSlackThreadTailWindow({
      app,
      channel,
      threadId: request.threadId!,
      latest,
      limit: tailLimit,
    });
    if (tailResponse.ok === false) return tailResponse;
    messages.push(...(tailResponse.messages || []));
  }

  return {
    ...first,
    messages,
    response_metadata:
      tailResponse?.response_metadata || first.response_metadata,
  };
}

async function fetchSlackThreadTailWindow(input: {
  app: App;
  channel: string;
  threadId: string;
  latest: string | undefined;
  limit: number;
}): Promise<SlackHydratedMessagesResponse> {
  const latestSeconds = Number(input.latest);
  if (!Number.isFinite(latestSeconds)) {
    return { ok: true, messages: [] };
  }

  let lookbackSeconds = THREAD_TAIL_INITIAL_LOOKBACK_SECONDS;
  let response: SlackHydratedMessagesResponse = { ok: true, messages: [] };
  for (let attempt = 0; attempt < THREAD_TAIL_WINDOW_ATTEMPTS; attempt += 1) {
    response = (await input.app.client.conversations.replies({
      channel: input.channel,
      ts: input.threadId,
      latest: input.latest,
      oldest: slackTailWindowOldest(latestSeconds, lookbackSeconds),
      inclusive: false,
      limit: input.limit,
    })) as SlackHydratedMessagesResponse;
    if (response.ok === false) return response;

    if (
      slackTailWindowIsDense(
        response,
        input.limit,
        latestSeconds,
        lookbackSeconds,
      )
    ) {
      const nextLookbackSeconds = Math.max(
        THREAD_TAIL_MIN_LOOKBACK_SECONDS,
        lookbackSeconds / 4,
      );
      if (
        attempt < THREAD_TAIL_WINDOW_ATTEMPTS - 1 &&
        nextLookbackSeconds < lookbackSeconds
      ) {
        lookbackSeconds = nextLookbackSeconds;
        continue;
      }
    }

    if (
      (response.messages || []).length < input.limit &&
      lookbackSeconds < THREAD_TAIL_MAX_LOOKBACK_SECONDS &&
      attempt < THREAD_TAIL_WINDOW_ATTEMPTS - 1
    ) {
      lookbackSeconds = Math.min(
        THREAD_TAIL_MAX_LOOKBACK_SECONDS,
        lookbackSeconds * 4,
      );
      continue;
    }

    break;
  }
  return response;
}

function slackLatestCursor(
  latestMessage: ConversationContextHydrationRequest['latestMessage'],
): string | undefined {
  const externalId = latestMessage.external_message_id?.trim();
  if (externalId && isSlackTimestamp(externalId)) return externalId;

  const millis = Date.parse(latestMessage.timestamp);
  return Number.isFinite(millis) ? (millis / 1000).toFixed(6) : undefined;
}

function isSlackTimestamp(value: string): boolean {
  return /^\d{10,}\.\d{1,6}$/.test(value);
}

function slackTailWindowIsDense(
  response: SlackHydratedMessagesResponse,
  limit: number,
  latestSeconds: number,
  lookbackSeconds: number,
): boolean {
  if (response.has_more || response.response_metadata?.next_cursor?.trim()) {
    return true;
  }
  const messages = response.messages || [];
  if (messages.length < limit) return false;
  const firstMessageSeconds = slackTailMessageSeconds(messages[0]);
  if (firstMessageSeconds === null) return false;
  return latestSeconds - firstMessageSeconds > lookbackSeconds / 2;
}

function slackThreadTailFetchLimit(limit: number): number {
  return Math.max(
    0,
    limit - 1 - Math.min(THREAD_LONG_FIRST_REPLIES, Math.max(0, limit - 1)),
  );
}

function slackTailWindowOldest(
  latestSeconds: number,
  lookbackSeconds: number,
): string {
  return (latestSeconds - lookbackSeconds).toFixed(6);
}

function slackTailMessageSeconds(message: SlackMessageLike | undefined) {
  const seconds = Number(message?.ts);
  return Number.isFinite(seconds) ? seconds : null;
}

function failedSlackHydration(
  request: ConversationContextHydrationRequest,
  reason: string,
): ConversationContextHydrationResult {
  logger.debug(
    {
      providerId: 'slack',
      conversationJid: request.conversationJid,
      threadId: request.threadId,
      reason,
    },
    'Slack context hydration failed',
  );
  return {
    providerId: 'slack',
    attempted: true,
    failed: true,
    reason,
    messages: [],
  };
}

async function normalizeHydratedSlackMessages(input: {
  jid: string;
  requestedThreadId: string | undefined;
  rawMessages: SlackMessageLike[];
  limit: number;
  botUserId: string | null;
  resolveUserName(userId: string | undefined): Promise<string>;
}): Promise<NewMessage[]> {
  const rawMessages = selectHydratedSlackMessages({
    rawMessages: input.rawMessages,
    limit: input.limit,
    requestedThreadId: input.requestedThreadId,
  });
  const byExternalId = new Map<string, NewMessage>();
  for (const message of rawMessages) {
    const content = hydratedSlackContent(message);
    if (!message.ts || !content) continue;
    const attachments = hydratedSlackAttachments(message);
    const sender = message.user || message.bot_id || 'unknown';
    const isSelfMessage = isConfiguredSlackSelfMessage(
      message,
      input.botUserId,
    );
    const threadId = input.requestedThreadId || message.thread_ts || undefined;
    byExternalId.set(message.ts, {
      id: message.ts,
      chat_jid: input.jid,
      provider: 'slack',
      sender,
      sender_name: message.user
        ? await input.resolveUserName(message.user)
        : sender,
      content,
      timestamp: slackTsToIso(message.ts),
      is_from_me: isSelfMessage,
      is_bot_message: isSelfMessage,
      ...(isSelfMessage ? { delivery_status: 'sent' } : {}),
      external_message_id: message.ts,
      thread_id: threadId,
      reply_to_message_id:
        threadId && threadId !== message.ts ? threadId : undefined,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }
  return Array.from(byExternalId.values()).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
}

function selectHydratedSlackMessages(input: {
  rawMessages: SlackMessageLike[];
  limit: number;
  requestedThreadId: string | undefined;
}): SlackMessageLike[] {
  const byExternalId = new Map<string, SlackMessageLike>();
  for (const message of input.rawMessages) {
    if (!isHydratableSlackMessage(message)) continue;
    byExternalId.set(message.ts!, message);
  }
  const messages = Array.from(byExternalId.values()).sort(compareSlackMessages);
  if (!input.requestedThreadId || messages.length <= input.limit) {
    return messages.slice(0, input.limit);
  }

  const firstReplyCount = Math.min(
    THREAD_LONG_FIRST_REPLIES,
    Math.max(0, input.limit - 1),
  );
  const latestReplyCount = Math.max(0, input.limit - 1 - firstReplyCount);
  const latestReplies =
    latestReplyCount > 0 ? messages.slice(1).slice(-latestReplyCount) : [];
  return dedupeSlackMessages([
    ...messages.slice(0, 1),
    ...messages.slice(1, firstReplyCount + 1),
    ...latestReplies,
  ]);
}

function isHydratableSlackMessage(message: SlackMessageLike): boolean {
  return Boolean(
    message.ts &&
    (!message.subtype ||
      message.subtype === 'file_share' ||
      message.subtype === 'bot_message') &&
    hydratedSlackContent(message),
  );
}

function isConfiguredSlackSelfMessage(
  message: SlackMessageLike,
  botUserId: string | null,
): boolean {
  if (!botUserId) return false;
  return message.user === botUserId || message.bot_id === botUserId;
}

function dedupeSlackMessages(messages: SlackMessageLike[]): SlackMessageLike[] {
  const seen = new Set<string>();
  const result: SlackMessageLike[] = [];
  for (const message of messages.sort(compareSlackMessages)) {
    if (!message.ts || seen.has(message.ts)) continue;
    seen.add(message.ts);
    result.push(message);
  }
  return result;
}

function compareSlackMessages(left: SlackMessageLike, right: SlackMessageLike) {
  return slackTsSortValue(left.ts) - slackTsSortValue(right.ts);
}

function slackTsSortValue(ts: string | undefined): number {
  const value = Number(ts);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function hydratedSlackContent(message: SlackMessageLike): string {
  const lines: string[] = [];
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (text) lines.push(text);
  for (const file of message.files || []) {
    const label = file.name || file.title || 'attachment';
    lines.push(`Attachment: ${label}`);
  }
  return lines.join('\n').trim();
}

function hydratedSlackAttachments(
  message: SlackMessageLike,
): NonNullable<NewMessage['attachments']> {
  const attachments: NonNullable<NewMessage['attachments']> = [];
  for (const file of (message.files || []) as SlackHydratedFile[]) {
    attachments.push({
      id: file.id ? `slack-file:${file.id}` : undefined,
      kind: file.mimetype?.startsWith('image/') ? 'image' : 'file',
      contentType: file.mimetype,
      sizeBytes:
        typeof file.size === 'number' && Number.isFinite(file.size)
          ? file.size
          : undefined,
      externalId: file.id,
    });
  }
  return attachments;
}

function slackTsToIso(ts: string | undefined): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return new Date().toISOString();
  return new Date(Math.round(seconds * 1000)).toISOString();
}
