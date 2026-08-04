export const DISCORD_API_ROOT = 'https://discord.com/api/v10';
export const DISCORD_JID_PREFIX = 'dc:';
export function discordUserName(user, fallback = 'unknown') {
    return user?.username || user?.id || fallback;
}
function discordSlashOptionText(option) {
    if (option.value === undefined || option.value === null)
        return '';
    return String(option.value).trim();
}
export function discordGantrySlashText(interaction) {
    const subcommand = interaction.data?.options?.[0];
    const name = subcommand?.name?.trim() || 'help';
    const args = (subcommand?.options || [])
        .map(discordSlashOptionText)
        .filter(Boolean);
    return ['/gantry', name, ...args].join(' ');
}
export function discordChannelIdFromJid(jid) {
    const trimmed = jid.trim();
    if (!trimmed)
        return null;
    return trimmed.startsWith(DISCORD_JID_PREFIX)
        ? trimmed.slice(DISCORD_JID_PREFIX.length)
        : trimmed;
}
export function discordHeaders(token) {
    return {
        authorization: `Bot ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
    };
}
export async function ackDiscordInteraction(botToken, interaction, content) {
    await fetch(`${DISCORD_API_ROOT}/interactions/${encodeURIComponent(interaction.id || '')}/${encodeURIComponent(interaction.token || '')}/callback`, {
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
    });
}
export async function updateDiscordInteractionResponse(applicationId, interaction, content) {
    await fetch(`${DISCORD_API_ROOT}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interaction.token || '')}/messages/@original`, {
        method: 'PATCH',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            content,
            allowed_mentions: { parse: [] },
        }),
    });
}
