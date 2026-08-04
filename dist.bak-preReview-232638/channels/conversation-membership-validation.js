import { getOptionalRuntimeSecret, normalizeRuntimeSecretRefString, } from '../domain/ports/runtime-secret-provider.js';
import { normalizeProviderId } from './provider-registry.js';
const TOKEN_BOUND_HTTP_GUIDANCE = 'Verify provider credentials and retry.';
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;
const DISCORD_ADMINISTRATOR = 1n << 3n;
const DISCORD_VIEW_CHANNEL = 1n << 10n;
const DISCORD_SEND_MESSAGES = 1n << 11n;
const DISCORD_READ_MESSAGE_HISTORY = 1n << 16n;
export const DISCORD_RUNTIME_CHANNEL_PERMISSION_BITS = DISCORD_VIEW_CHANNEL | DISCORD_SEND_MESSAGES | DISCORD_READ_MESSAGE_HISTORY;
function discordBits(value) {
    try {
        return BigInt(value ?? 0);
    }
    catch {
        return 0n;
    }
}
function applyDiscordOverwrite(permissions, overwrite) {
    if (!overwrite)
        return permissions;
    return ((permissions & ~discordBits(overwrite.deny)) | discordBits(overwrite.allow));
}
export function discordMemberHasChannelPermissions(input) {
    const rolePermissions = new Map(input.roles.map((role) => [role.id || '', discordBits(role.permissions)]));
    let permissions = rolePermissions.get(input.guildId) ?? 0n;
    for (const roleId of input.memberRoles) {
        permissions |= rolePermissions.get(roleId) ?? 0n;
    }
    if ((permissions & DISCORD_ADMINISTRATOR) === DISCORD_ADMINISTRATOR)
        return true;
    permissions = applyDiscordOverwrite(permissions, input.overwrites.find((overwrite) => overwrite.id === input.guildId));
    let roleAllow = 0n;
    let roleDeny = 0n;
    for (const overwrite of input.overwrites) {
        if (overwrite.type !== 0 ||
            !input.memberRoles.includes(overwrite.id || '')) {
            continue;
        }
        roleAllow |= discordBits(overwrite.allow);
        roleDeny |= discordBits(overwrite.deny);
    }
    permissions = (permissions & ~roleDeny) | roleAllow;
    permissions = applyDiscordOverwrite(permissions, input.overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === input.userId));
    const required = input.requiredPermissions ?? DISCORD_VIEW_CHANNEL;
    return (permissions & required) === required;
}
export class RuntimeSecretConversationMembershipValidator {
    secrets;
    constructor(secrets) {
        this.secrets = secrets;
    }
    async validateControlApprovers(input) {
        const providerId = normalizeProviderId(String(input.providerId));
        if (providerId === 'telegram')
            return this.validateTelegram(input);
        if (providerId === 'slack')
            return this.validateSlack(input);
        if (providerId === 'discord')
            return this.validateDiscord(input);
        if (providerId === 'teams')
            return this.validateTeams(input);
        return {
            validUserIds: [],
            invalidUserIds: input.userIds,
            reason: `${providerId} conversation membership validation is not implemented.`,
        };
    }
    async validateTelegram(input) {
        const token = await this.resolveSecret(input.providerAccount.runtimeSecretRefs, ['bot_token']);
        if (!token) {
            return {
                validUserIds: [],
                invalidUserIds: input.userIds,
                reason: 'Telegram token is not configured.',
            };
        }
        if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) {
            return {
                validUserIds: [],
                invalidUserIds: input.userIds,
                reason: 'Telegram token is invalid.',
            };
        }
        const chatId = externalConversationValue(input).replace(/^tg:/, '');
        const checks = await Promise.all(input.userIds.map(async (userId) => {
            try {
                const response = await fetchWithTimeout(`https://api.telegram.org/bot${encodeURIComponent(token)}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`);
                if (!response.ok) {
                    return { userId, valid: false };
                }
                const payload = (await response.json());
                const status = payload.result?.status?.toLowerCase() || '';
                return {
                    userId,
                    valid: Boolean(payload.ok) &&
                        Boolean(status) &&
                        status !== 'left' &&
                        status !== 'kicked',
                };
            }
            catch {
                return { userId, valid: false };
            }
        }));
        const validUserIds = checks
            .filter((entry) => entry.valid)
            .map((entry) => entry.userId);
        const invalidUserIds = checks
            .filter((entry) => !entry.valid)
            .map((entry) => entry.userId);
        return {
            validUserIds,
            invalidUserIds,
            reason: invalidUserIds.length ? TOKEN_BOUND_HTTP_GUIDANCE : undefined,
        };
    }
    async validateSlack(input) {
        const botToken = await this.resolveSecret(input.providerAccount.runtimeSecretRefs, ['bot_token']);
        if (!botToken) {
            return {
                validUserIds: [],
                invalidUserIds: input.userIds,
                reason: 'Slack bot token is not configured.',
            };
        }
        const channelId = externalConversationValue(input).replace(/^sl:/, '');
        try {
            const members = await this.listSlackMembers(botToken, channelId);
            const memberSet = new Set(members);
            return {
                validUserIds: input.userIds.filter((id) => memberSet.has(id)),
                invalidUserIds: input.userIds.filter((id) => !memberSet.has(id)),
            };
        }
        catch {
            return {
                validUserIds: [],
                invalidUserIds: input.userIds,
                reason: TOKEN_BOUND_HTTP_GUIDANCE,
            };
        }
    }
    async listSlackMembers(botToken, channelId) {
        const members = [];
        let cursor = '';
        do {
            const url = new URL('https://slack.com/api/conversations.members');
            url.searchParams.set('channel', channelId);
            url.searchParams.set('limit', '1000');
            if (cursor)
                url.searchParams.set('cursor', cursor);
            const response = await fetchWithTimeout(url.toString(), {
                headers: { authorization: `Bearer ${botToken}` },
            });
            if (!response.ok)
                throw new Error('Slack membership check failed');
            const payload = (await response.json());
            if (!payload.ok)
                throw new Error('Slack membership check failed');
            members.push(...(payload.members || []));
            cursor = payload.response_metadata?.next_cursor || '';
        } while (cursor);
        return members;
    }
    async validateDiscord(input) {
        const botToken = await this.resolveSecret(input.providerAccount.runtimeSecretRefs, ['bot_token']);
        if (!botToken) {
            return {
                validUserIds: [],
                invalidUserIds: input.userIds,
                reason: 'Discord bot token is not configured.',
            };
        }
        try {
            const channelId = externalConversationValue(input).replace(/^dc:/, '');
            const channelResponse = await fetchWithTimeout(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
                headers: { authorization: `Bot ${botToken}` },
            });
            if (!channelResponse.ok) {
                throw new Error('Discord channel lookup failed');
            }
            const channel = (await channelResponse.json());
            if (!channel.guild_id) {
                throw new Error('Discord guild id missing');
            }
            if (!Array.isArray(channel.permission_overwrites)) {
                throw new Error('Discord channel permission overwrites missing');
            }
            const rolesResponse = await fetchWithTimeout(`https://discord.com/api/v10/guilds/${encodeURIComponent(channel.guild_id)}/roles`, { headers: { authorization: `Bot ${botToken}` } });
            if (!rolesResponse.ok)
                throw new Error('Discord role lookup failed');
            const roles = (await rolesResponse.json());
            const checks = await Promise.all(input.userIds.map(async (userId) => {
                try {
                    const response = await fetchWithTimeout(`https://discord.com/api/v10/guilds/${encodeURIComponent(channel.guild_id || '')}/members/${encodeURIComponent(userId)}`, { headers: { authorization: `Bot ${botToken}` } });
                    if (!response.ok)
                        return { userId, valid: false };
                    const member = (await response.json());
                    return {
                        userId,
                        valid: discordMemberHasChannelPermissions({
                            guildId: channel.guild_id || '',
                            userId,
                            memberRoles: member.roles ?? [],
                            roles,
                            overwrites: channel.permission_overwrites ?? [],
                        }),
                    };
                }
                catch {
                    return { userId, valid: false };
                }
            }));
            return {
                validUserIds: checks
                    .filter((entry) => entry.valid)
                    .map((entry) => entry.userId),
                invalidUserIds: checks
                    .filter((entry) => !entry.valid)
                    .map((entry) => entry.userId),
            };
        }
        catch {
            return {
                validUserIds: [],
                invalidUserIds: input.userIds,
                reason: TOKEN_BOUND_HTTP_GUIDANCE,
            };
        }
    }
    async validateTeams(input) {
        const clientId = await this.resolveSecret(input.providerAccount.runtimeSecretRefs, ['client_id']);
        const clientSecret = await this.resolveSecret(input.providerAccount.runtimeSecretRefs, ['client_secret']);
        const tenantId = await this.resolveSecret(input.providerAccount.runtimeSecretRefs, ['tenant_id']);
        if (!clientId || !clientSecret || !tenantId) {
            return {
                validUserIds: [],
                invalidUserIds: input.userIds,
                reason: 'Teams Graph credentials are not configured.',
            };
        }
        try {
            const accessToken = await this.fetchTeamsGraphToken({
                clientId,
                clientSecret,
                tenantId,
            });
            const members = await this.listTeamsMembers(input, accessToken);
            const memberSet = new Set(members);
            return {
                validUserIds: input.userIds.filter((id) => memberSet.has(id)),
                invalidUserIds: input.userIds.filter((id) => !memberSet.has(id)),
            };
        }
        catch {
            return {
                validUserIds: [],
                invalidUserIds: input.userIds,
                reason: TOKEN_BOUND_HTTP_GUIDANCE,
            };
        }
    }
    async fetchTeamsGraphToken(input) {
        const body = new URLSearchParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            grant_type: 'client_credentials',
            scope: 'https://graph.microsoft.com/.default',
        });
        const response = await fetchWithTimeout(`https://login.microsoftonline.com/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
            },
            body,
        });
        if (!response.ok)
            throw new Error('Teams token request failed');
        const payload = (await response.json());
        if (!payload.access_token)
            throw new Error('Teams token missing');
        return payload.access_token;
    }
    async listTeamsMembers(input, accessToken) {
        const endpoint = teamsMembersEndpoint(input);
        const members = [];
        let nextUrl = endpoint;
        while (nextUrl) {
            const response = await fetchWithTimeout(nextUrl, {
                headers: { authorization: `Bearer ${accessToken}` },
            });
            if (!response.ok)
                throw new Error('Teams membership check failed');
            const payload = (await response.json());
            for (const member of payload.value || []) {
                for (const value of [
                    member.userId,
                    member.id,
                    member.email,
                    member.userPrincipalName,
                ]) {
                    if (typeof value === 'string' && value.trim()) {
                        members.push(value.trim());
                    }
                }
            }
            nextUrl = payload['@odata.nextLink'];
        }
        return members;
    }
    async resolveSecret(refs, preferredKeys) {
        const candidates = preferredKeys
            .map((key) => refs[key])
            .filter((ref) => Boolean(ref?.trim()));
        for (const ref of candidates) {
            const value = await getOptionalRuntimeSecret(this.secrets, {
                ref: normalizeRuntimeSecretRefString(ref),
            });
            if (value)
                return value;
        }
        return '';
    }
}
async function fetchWithTimeout(url, init, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...(init || {}), signal: controller.signal });
    }
    finally {
        clearTimeout(timeout);
    }
}
function externalConversationValue(input) {
    return input.conversation.externalRef?.value || input.conversation.id;
}
function teamsMembersEndpoint(input) {
    const config = input.providerAccount.config &&
        typeof input.providerAccount.config === 'object'
        ? input.providerAccount.config
        : {};
    const teamId = stringConfigValue(config, 'teamId');
    const channelId = stringConfigValue(config, 'channelId');
    if (teamId && channelId) {
        return `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/members`;
    }
    const chatId = stringConfigValue(config, 'chatId') ||
        externalConversationValue(input).replace(/^teams:/, '');
    return `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/members`;
}
function stringConfigValue(config, key) {
    const value = config[key];
    return typeof value === 'string' ? value.trim() : '';
}
