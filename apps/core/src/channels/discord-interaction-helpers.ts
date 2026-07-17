import type {
  DiscordInteraction,
  DiscordInteractionOption,
  DiscordUser,
} from './discord-types.js';

export const DISCORD_API_ROOT = 'https://discord.com/api/v10';
export const DISCORD_JID_PREFIX = 'dc:';

export function discordUserName(
  user: DiscordUser | undefined,
  fallback = 'unknown',
): string {
  return user?.username || user?.id || fallback;
}

function discordSlashOptionText(option: DiscordInteractionOption): string {
  if (option.value === undefined || option.value === null) return '';
  return String(option.value).trim();
}

export function discordGantrySlashText(
  interaction: DiscordInteraction,
): string {
  const subcommand = interaction.data?.options?.[0];
  const name = subcommand?.name?.trim() || 'help';
  const args = (subcommand?.options || [])
    .map(discordSlashOptionText)
    .filter(Boolean);
  return ['/gantry', name, ...args].join(' ');
}

export function discordChannelIdFromJid(jid: string): string | null {
  const trimmed = jid.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(DISCORD_JID_PREFIX)
    ? trimmed.slice(DISCORD_JID_PREFIX.length)
    : trimmed;
}

export function discordHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bot ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

export async function ackDiscordInteraction(
  botToken: string,
  interaction: DiscordInteraction,
  content: string,
): Promise<void> {
  await fetch(
    `${DISCORD_API_ROOT}/interactions/${encodeURIComponent(interaction.id || '')}/${encodeURIComponent(interaction.token || '')}/callback`,
    {
      method: 'POST',
      headers: discordHeaders(botToken),
      body: JSON.stringify({
        type: 4,
        data: {
          content,
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      }),
    },
  );
}
