import { normalizeDiscordJid } from './discord.js';
import { DISCORD_RUNTIME_CHANNEL_PERMISSION_BITS, discordMemberHasChannelPermissions, } from './conversation-membership-validation.js';
const DISCORD_API_ROOT = 'https://discord.com/api/v10';
const DISCORD_OPTION_SUBCOMMAND = 1;
const DISCORD_OPTION_STRING = 3;
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
const DISCORD_GUIDANCE = 'Check the bot token, application id, bot install, bot scope, applications.commands scope, Message Content intent, and channel permissions, then retry.';
export function trimDiscordSetupCredentials(credentials) {
    return {
        botToken: credentials.botToken.trim(),
        applicationId: credentials.applicationId.trim(),
    };
}
function botHeaders(token) {
    return {
        authorization: `Bot ${token}`,
        accept: 'application/json',
    };
}
async function fetchWithTimeout(url, timeoutMs, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...(init || {}), signal: controller.signal });
    }
    finally {
        clearTimeout(timeout);
    }
}
async function readJson(response) {
    return (await response.json());
}
function isSnowflake(value) {
    return /^\d{5,32}$/.test(value);
}
function normalizeDiscordChannel(input) {
    const chatJid = normalizeDiscordJid(input.channelId);
    if (!chatJid)
        return null;
    const typeLabel = input.channelType === 5
        ? 'announcement'
        : input.channelType === 15
            ? 'forum'
            : 'text';
    return {
        chatJid,
        chatTitle: `${input.guildName} / #${input.channelName}`,
        guildId: input.guildId,
        guildName: input.guildName,
        channelId: input.channelId,
        channelName: input.channelName,
        channelType: typeLabel,
    };
}
export class RestDiscordSetupDiscoveryClient {
    async validateCredentials(credentials) {
        return validateDiscordCredentials(credentials);
    }
    async listChannels(options) {
        return listDiscordChannels(options);
    }
    async verifyChannel(options) {
        return verifyDiscordChannelAccess(options);
    }
    async registerGantryCommand(options) {
        return registerDiscordGantryCommand(options);
    }
}
export async function validateDiscordCredentials(credentials) {
    const trimmed = trimDiscordSetupCredentials(credentials);
    if (!trimmed.botToken || !trimmed.applicationId) {
        return {
            ok: false,
            message: 'Discord credentials are incomplete.',
            nextAction: 'Enter DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID.',
        };
    }
    if (!isSnowflake(trimmed.applicationId)) {
        return {
            ok: false,
            message: 'Discord application id must be a numeric snowflake.',
            nextAction: 'Copy the Application ID from the Discord Developer Portal.',
        };
    }
    try {
        const response = await fetchWithTimeout(`${DISCORD_API_ROOT}/users/@me`, 10_000, {
            headers: botHeaders(trimmed.botToken),
        });
        if (!response.ok)
            throw new Error('Discord token validation failed');
        const applicationResponse = await fetchWithTimeout(`${DISCORD_API_ROOT}/oauth2/applications/@me`, 10_000, { headers: botHeaders(trimmed.botToken) });
        if (!applicationResponse.ok) {
            throw new Error('Discord application validation failed');
        }
        const application = await readJson(applicationResponse);
        if (application.id !== trimmed.applicationId) {
            return {
                ok: false,
                message: 'Discord application id does not match the bot token.',
                nextAction: 'Copy the Application ID for the same bot token.',
            };
        }
        const flags = application.flags ?? 0;
        if ((flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) ===
            0) {
            return {
                ok: false,
                message: 'Discord Message Content intent is not enabled.',
                nextAction: 'Enable Message Content Intent on the Discord Developer Portal Bot page, then retry.',
            };
        }
        return { ok: true, message: 'Discord bot token validated.' };
    }
    catch {
        return {
            ok: false,
            message: 'Discord bot token validation failed.',
            nextAction: DISCORD_GUIDANCE,
        };
    }
}
export async function listDiscordChannels(options) {
    const credentials = trimDiscordSetupCredentials(options.credentials);
    try {
        const guildResponse = await fetchWithTimeout(`${DISCORD_API_ROOT}/users/@me/guilds`, 10_000, {
            headers: botHeaders(credentials.botToken),
        });
        if (!guildResponse.ok)
            throw new Error('Discord guild list failed');
        const guilds = await readJson(guildResponse);
        const channels = [];
        for (const guild of guilds) {
            if (!guild.id || !guild.name)
                continue;
            const channelResponse = await fetchWithTimeout(`${DISCORD_API_ROOT}/guilds/${encodeURIComponent(guild.id)}/channels`, 10_000, { headers: botHeaders(credentials.botToken) });
            if (!channelResponse.ok)
                continue;
            const rows = await readJson(channelResponse);
            for (const row of rows) {
                if (!row.id || !row.name || ![0, 5].includes(row.type ?? -1)) {
                    continue;
                }
                const channel = normalizeDiscordChannel({
                    guildId: guild.id,
                    guildName: guild.name,
                    channelId: row.id,
                    channelName: row.name,
                    channelType: row.type ?? 0,
                });
                if (channel)
                    channels.push(channel);
                if (channels.length >= (options.limit ?? 50))
                    break;
            }
            if (channels.length >= (options.limit ?? 50))
                break;
        }
        return {
            ok: true,
            channels,
            message: `Discovered ${channels.length} Discord channel(s).`,
            ...(channels.length === 0 ? { nextAction: DISCORD_GUIDANCE } : {}),
        };
    }
    catch {
        return {
            ok: false,
            channels: [],
            message: 'Discord channel discovery failed.',
            nextAction: DISCORD_GUIDANCE,
        };
    }
}
export async function verifyDiscordChannelAccess(options) {
    if (!isSnowflake(options.guildId) || !isSnowflake(options.channelId)) {
        return {
            ok: false,
            message: 'Discord guild id and channel id must be numeric snowflakes.',
            nextAction: 'Copy the guild id and channel id from Discord developer mode.',
        };
    }
    const discovery = await listDiscordChannels({
        credentials: options.credentials,
        limit: 200,
    });
    const channel = discovery.channels.find((candidate) => candidate.guildId === options.guildId &&
        candidate.channelId === options.channelId);
    if (!channel) {
        return {
            ok: false,
            message: 'Discord channel was not visible to the bot.',
            nextAction: DISCORD_GUIDANCE,
        };
    }
    try {
        const credentials = trimDiscordSetupCredentials(options.credentials);
        const botResponse = await fetchWithTimeout(`${DISCORD_API_ROOT}/users/@me`, 10_000, {
            headers: botHeaders(credentials.botToken),
        });
        if (!botResponse.ok)
            throw new Error('Discord bot identity check failed');
        const bot = await readJson(botResponse);
        if (!bot.id)
            throw new Error('Discord bot identity missing id');
        const [rolesResponse, memberResponse, channelResponse] = await Promise.all([
            fetchWithTimeout(`${DISCORD_API_ROOT}/guilds/${encodeURIComponent(options.guildId)}/roles`, 10_000, { headers: botHeaders(credentials.botToken) }),
            fetchWithTimeout(`${DISCORD_API_ROOT}/guilds/${encodeURIComponent(options.guildId)}/members/${encodeURIComponent(bot.id)}`, 10_000, { headers: botHeaders(credentials.botToken) }),
            fetchWithTimeout(`${DISCORD_API_ROOT}/channels/${encodeURIComponent(options.channelId)}`, 10_000, { headers: botHeaders(credentials.botToken) }),
        ]);
        if (!rolesResponse.ok || !memberResponse.ok || !channelResponse.ok) {
            throw new Error('Discord channel permission check failed');
        }
        const roles = await readJson(rolesResponse);
        const member = await readJson(memberResponse);
        const channelDetails = await readJson(channelResponse);
        if (!discordMemberHasChannelPermissions({
            guildId: options.guildId,
            userId: bot.id,
            memberRoles: member.roles ?? [],
            roles,
            overwrites: channelDetails.permission_overwrites ?? [],
            requiredPermissions: DISCORD_RUNTIME_CHANNEL_PERMISSION_BITS,
        })) {
            return {
                ok: false,
                message: 'Discord bot lacks required channel permissions.',
                nextAction: 'Grant View Channel, Send Messages, and Read Message History to the bot, then retry.',
            };
        }
    }
    catch {
        return {
            ok: false,
            message: 'Discord channel permission verification failed.',
            nextAction: DISCORD_GUIDANCE,
        };
    }
    return { ok: true, message: 'Discord channel verified.', ...channel };
}
export async function registerDiscordGantryCommand(options) {
    const credentials = trimDiscordSetupCredentials(options.credentials);
    try {
        const response = await fetchWithTimeout(`${DISCORD_API_ROOT}/applications/${encodeURIComponent(credentials.applicationId)}/guilds/${encodeURIComponent(options.guildId)}/commands`, 10_000, {
            method: 'POST',
            headers: {
                ...botHeaders(credentials.botToken),
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                name: 'gantry',
                description: 'Gantry commands and status',
                type: 1,
                options: [
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'help',
                        description: 'Show Gantry commands',
                    },
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'stop',
                        description: 'Stop the current run',
                    },
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'status',
                        description: 'Show model and runtime status',
                    },
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'memory-status',
                        description: 'Show durable memory status',
                    },
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'dream',
                        description: 'Run memory dreaming',
                    },
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'new',
                        description: 'Start a fresh session',
                    },
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'compact',
                        description: 'Compact context and save memory',
                    },
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'models',
                        description: 'List model aliases',
                    },
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'model',
                        description: 'Show or change the model',
                        options: [
                            {
                                type: DISCORD_OPTION_STRING,
                                name: 'value',
                                description: 'Alias, default, or why <alias>',
                                required: false,
                            },
                        ],
                    },
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'thinking',
                        description: 'Show or change thinking',
                        options: [
                            {
                                type: DISCORD_OPTION_STRING,
                                name: 'value',
                                description: 'low, medium, high, max, adaptive, enabled, off, or default',
                                required: false,
                            },
                        ],
                    },
                    {
                        type: DISCORD_OPTION_SUBCOMMAND,
                        name: 'save-procedure',
                        description: 'Save reusable procedure steps',
                        options: [
                            {
                                type: DISCORD_OPTION_STRING,
                                name: 'title',
                                description: 'Procedure title',
                                required: true,
                            },
                        ],
                    },
                ],
            }),
        });
        if (!response.ok)
            throw new Error('Discord command registration failed');
        return { ok: true, message: 'Registered Discord /gantry command.' };
    }
    catch {
        return {
            ok: false,
            message: 'Discord /gantry command registration failed.',
            nextAction: DISCORD_GUIDANCE,
        };
    }
}
