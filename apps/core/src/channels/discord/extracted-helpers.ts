import type { PermissionApprovalRequest } from '../../domain/types.js';
import type { ChannelOpts } from '../channel-provider.js';
import type { DiscordInteraction } from './types.js';

export const DISCORD_API_ROOT = 'https://discord.com/api/v10';
export const DISCORD_GATEWAY_INTENTS =
  (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
export const DISCORD_JID_PREFIX = 'dc:';

export type DiscordConversationContext = {
  conversationJid: string;
  threadId?: string;
};

export function normalizeDiscordJid(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(DISCORD_JID_PREFIX)
    ? trimmed
    : `${DISCORD_JID_PREFIX}${trimmed}`;
}

export function discordChannelIdFromJid(jid: string): string | null {
  const normalized = normalizeDiscordJid(jid);
  return normalized ? normalized.slice(DISCORD_JID_PREFIX.length) : null;
}

export async function isDiscordInteractionApproverAllowed(
  opts: ChannelOpts,
  interaction: DiscordInteraction,
  userId: string | undefined,
  sourceAgentFolder: string,
  decisionPolicy: PermissionApprovalRequest['decisionPolicy'] = 'same_channel',
  threadId?: string,
  conversationJid = `${DISCORD_JID_PREFIX}${interaction.channel_id}`,
): Promise<boolean> {
  if (!userId || !opts.isControlApproverAllowed) return false;
  return opts.isControlApproverAllowed({
    providerId: 'discord',
    providerAccountId: opts.providerAccountId,
    agentId: opts.agentId,
    conversationJid,
    threadId,
    userId,
    sourceAgentFolder,
    decisionPolicy,
  });
}
