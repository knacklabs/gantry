/**
 * Provider-neutral owner / delivery labels for user-facing copy.
 *
 * Maps a Gantry conversation JID (+ optional thread) to the locked, human label
 * strings used by channel-facing prompts and Gantry MCP summaries. JID prefixes
 * mirror the registry's builtInProviderJidPrefixes.
 *
 * Labels are rendering terms only — they carry no authority and never appear as
 * raw transport ids in primary copy.
 */

type ProviderKey = 'telegram' | 'slack' | 'teams' | 'app';
type ConversationKind = 'dm' | 'channel';

function providerKeyForJid(conversationJid: string): ProviderKey | undefined {
  if (conversationJid.startsWith('tg:')) return 'telegram';
  if (conversationJid.startsWith('sl:')) return 'slack';
  if (conversationJid.startsWith('teams:')) return 'teams';
  if (conversationJid.startsWith('app:')) return 'app';
  return undefined;
}

function hasThread(threadId: string | null | undefined): boolean {
  return typeof threadId === 'string' && threadId.trim().length > 0;
}

/**
 * Human label for where a message is delivered, thread-aware.
 * e.g. a Telegram topic, a Slack thread, otherwise the parent conversation.
 */
export function deliveryLabel(
  conversationJid: string,
  threadId: string | null | undefined,
  conversationKind?: ConversationKind,
): string {
  const thread = hasThread(threadId);
  switch (providerKeyForJid(conversationJid)) {
    case 'telegram':
      if (thread) return 'Telegram topic';
      return isTelegramGroupJid(conversationJid)
        ? 'Telegram group'
        : 'Telegram chat';
    case 'slack':
      if (thread) return 'Slack thread';
      if (conversationKind === 'dm' || isSlackDmJid(conversationJid)) {
        return 'Slack DM';
      }
      if (
        conversationKind === 'channel' ||
        isSlackChannelJid(conversationJid)
      ) {
        return 'Slack channel';
      }
      return 'Slack conversation';
    case 'teams':
      if (thread) return 'Teams reply thread';
      if (conversationKind === 'dm') return 'Teams chat';
      if (conversationKind === 'channel') return 'Teams channel';
      return 'Teams conversation';
    case 'app':
      return thread ? 'App session' : 'App conversation';
    default:
      return 'conversation';
  }
}

/**
 * Human label for the conversation that owns a message or job.
 * Always the conversation level, never the thread/topic.
 */
export function ownerLabel(
  conversationJid: string,
  conversationKind?: ConversationKind,
): string {
  switch (providerKeyForJid(conversationJid)) {
    case 'telegram':
      return isTelegramGroupJid(conversationJid)
        ? 'Telegram group'
        : 'Telegram chat';
    case 'slack':
      if (conversationKind === 'dm' || isSlackDmJid(conversationJid)) {
        return 'Slack DM';
      }
      if (
        conversationKind === 'channel' ||
        isSlackChannelJid(conversationJid)
      ) {
        return 'Slack channel';
      }
      return 'Slack conversation';
    case 'teams':
      if (conversationKind === 'dm') return 'Teams chat';
      if (conversationKind === 'channel') return 'Teams channel';
      return 'Teams conversation';
    case 'app':
      return 'App conversation';
    default:
      return 'conversation';
  }
}

function isTelegramGroupJid(conversationJid: string): boolean {
  return conversationJid.startsWith('tg:-');
}

function isSlackDmJid(conversationJid: string): boolean {
  return conversationJid.startsWith('sl:D');
}

function isSlackChannelJid(conversationJid: string): boolean {
  return conversationJid.startsWith('sl:C');
}
