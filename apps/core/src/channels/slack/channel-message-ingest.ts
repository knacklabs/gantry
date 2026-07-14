import type { ChannelOpts } from '../channel-provider.js';
import type { ConversationRoute, NewMessage } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  buildTriggerPattern,
  triggerForRoute,
} from '../../shared/trigger-pattern.js';
import {
  findConversationRoutesForChat,
  parseAgentThreadQueueKey,
} from '../../shared/thread-queue-key.js';
import { nowIso } from '../../shared/time/datetime.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import type { SlackMessageLike } from './channel-state.js';
import { ingestSlackSlashCommand as ingestSlackSlashCommandEvent } from './slash-command-ingest.js';

type SlackIngestOpts = Pick<
  ChannelOpts,
  | 'onMessage'
  | 'onChatMetadata'
  | 'conversationRoutes'
  | 'providerAccountId'
  | 'inboundProviderAccountIds'
>;
type EnrichedSlackMessage = {
  text: string;
  attachments: NonNullable<NewMessage['attachments']>;
};
type SlackRouteMatch = [string, ConversationRoute, string | undefined];

function dedupeRouteAliases(matches: SlackRouteMatch[]): SlackRouteMatch[] {
  const byIdentity = new Map<
    string,
    { match: SlackRouteMatch; specificity: number }
  >();
  for (const match of matches) {
    const [key, route, providerAccountId] = match;
    const parsed = parseAgentThreadQueueKey(key);
    const agentId =
      parsed.agentId ?? route.agentId ?? agentIdForFolder(route.folder);
    const routeProviderAccountId =
      parsed.providerAccountId ??
      route.providerAccountId ??
      providerAccountId ??
      '';
    const routeThreadId = parsed.threadId ?? '';
    const identity = `${agentId}::${routeProviderAccountId}::${routeThreadId}`;
    const specificity =
      (parsed.agentId ? 1 : 0) +
      (parsed.providerAccountId ? 1 : 0) +
      (parsed.threadId ? 1 : 0);
    const existing = byIdentity.get(identity);
    if (!existing || specificity >= existing.specificity) {
      byIdentity.set(identity, { match, specificity });
    }
  }
  return [...byIdentity.values()].map(({ match }) => match);
}

export async function ingestSlackSlashCommand(input: {
  command: {
    channel_id?: string;
    user_id?: string;
    user_name?: string;
    text?: string;
    trigger_id?: string;
    command_id?: string;
  };
  opts: SlackIngestOpts;
  resolveChannelName: (channelId: string) => Promise<string>;
  resolveUserName: (userId?: string) => Promise<string>;
  isLikelyGroupConversation: (channelId: string) => boolean;
}): Promise<void> {
  await ingestSlackSlashCommandEvent({
    command: input.command,
    opts: input.opts,
    resolveChannelName: input.resolveChannelName,
    resolveUserName: input.resolveUserName,
    isLikelyGroupConversation: input.isLikelyGroupConversation,
  });
}

export async function ingestSlackMessage(input: {
  event: SlackMessageLike;
  options?: { forceOwnedTopLevel?: boolean };
  opts: SlackIngestOpts;
  botUserId: string | null;
  resolveChannelName: (channelId: string) => Promise<string>;
  resolveUserName: (userId?: string) => Promise<string>;
  isLikelyGroupConversation: (channelId: string) => boolean;
  enrichMessage: (
    jid: string,
    event: SlackMessageLike,
    targetFolder?: string,
  ) => Promise<EnrichedSlackMessage>;
}): Promise<void> {
  const { event } = input;
  if (!event.channel || !event.ts) return;
  if (event.bot_id) return;
  if (event.subtype && event.subtype !== 'file_share') return;
  if (event.subtype === 'message_changed') return;
  if (event.edited) return;
  const jid = `sl:${event.channel}`;
  const chatName = await input.resolveChannelName(event.channel);
  await input.opts.onChatMetadata(
    jid,
    nowIso(),
    chatName,
    'slack',
    input.isLikelyGroupConversation(event.channel),
    { providerAccountId: input.opts.providerAccountId },
  );
  const isGroupConversation = input.isLikelyGroupConversation(event.channel);
  const routes = input.opts.conversationRoutes();
  const providerAccountIds =
    input.opts.inboundProviderAccountIds?.length && input.opts.providerAccountId
      ? input.opts.inboundProviderAccountIds
      : [input.opts.providerAccountId];
  const routeMatches = dedupeRouteAliases(
    providerAccountIds.flatMap((providerAccountId) =>
      findConversationRoutesForChat(
        routes,
        jid,
        event.thread_ts,
        providerAccountId,
      ).map((match) => [...match, providerAccountId] as SlackRouteMatch),
    ),
  );
  const singleRoute =
    routeMatches.length === 1 ? routeMatches[0]?.[1] : undefined;
  if (routeMatches.length < 1 && isGroupConversation) {
    logger.debug(
      { jid, chatName },
      'Message from unregistered Slack conversation',
    );
    return;
  }
  const enriched = await input.enrichMessage(jid, event);
  const rawContent = enriched.text;
  const content =
    input.botUserId && singleRoute
      ? rawContent.replace(
          new RegExp(`^<@${input.botUserId}>\\s+`),
          `${triggerForRoute(singleRoute)} `,
        )
      : input.botUserId && routeMatches.length > 1
        ? rawContent.replace(new RegExp(`^<@${input.botUserId}>\\s*`), '')
        : rawContent;
  if (!content) return;
  const triggeredRoutes =
    routeMatches.length > 1
      ? routeMatches.filter(([, route]) =>
          buildTriggerPattern(triggerForRoute(route)).test(content.trim()),
        )
      : [];
  const group =
    singleRoute ??
    (triggeredRoutes.length === 1 ? triggeredRoutes[0]?.[1] : undefined);
  const selectedProviderAccountIds = new Set(
    (group
      ? routeMatches.filter(([, route]) => route === group)
      : routeMatches
    ).map(([, , providerAccountId]) => providerAccountId),
  );
  const messageProviderAccountId =
    selectedProviderAccountIds.size === 1
      ? [...selectedProviderAccountIds][0]
      : selectedProviderAccountIds.size > 1
        ? undefined
        : input.opts.providerAccountId;
  const attachments =
    group &&
    Array.isArray(event.files) &&
    (routeMatches.length > 1 ||
      messageProviderAccountId !== input.opts.providerAccountId)
      ? (await input.enrichMessage(jid, event, group.folder)).attachments
      : enriched.attachments;
  const sender = event.user || 'unknown';
  const senderName = await input.resolveUserName(event.user);
  const ownsTopLevelMessage =
    input.options?.forceOwnedTopLevel ||
    (group
      ? group.requiresTrigger === false ||
        buildTriggerPattern(triggerForRoute(group)).test(content.trim())
      : false);
  const threadId =
    event.thread_ts ||
    (isGroupConversation && ownsTopLevelMessage ? event.ts : undefined);
  await input.opts.onMessage(jid, {
    id: event.ts,
    chat_jid: jid,
    provider: 'slack',
    ...(messageProviderAccountId
      ? { providerAccountId: messageProviderAccountId }
      : {}),
    sender,
    sender_name: senderName,
    content,
    timestamp: new Date(Math.round(Number(event.ts) * 1000)).toISOString(),
    is_from_me: input.botUserId ? sender === input.botUserId : false,
    external_message_id: event.ts,
    thread_id: threadId,
    attachments,
    reply_to_message_id:
      event.thread_ts && event.thread_ts !== event.ts
        ? event.thread_ts
        : undefined,
  });
}
