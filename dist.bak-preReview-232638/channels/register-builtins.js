import { registerProvider, } from './provider-registry.js';
async function createTelegramBuiltInChannel(opts) {
    const mod = await import('./telegram/channel-adapter.js');
    return await mod.createTelegramChannel(opts);
}
async function createSlackBuiltInChannel(opts) {
    const mod = await import('./slack/channel-adapter.js');
    return await mod.createSlackChannel(opts);
}
async function createTeamsBuiltInChannel(opts) {
    const mod = await import('./teams.js');
    return await mod.createTeamsChannel(opts);
}
async function createDiscordBuiltInChannel(opts) {
    const mod = await import('./discord.js');
    return await mod.createDiscordChannel(opts);
}
async function createAppBuiltInChannel(opts) {
    const mod = await import('./app.js');
    return await mod.createAppChannel(opts);
}
async function runBuiltInSetup(providerLabel, setup, ctx) {
    const code = await setup(ctx.runtimeHome, ctx.agentId, ctx.agentName);
    if (code !== 0) {
        throw new Error(`${providerLabel} connect command exited with status ${code}`);
    }
}
async function runTelegramSetup(runtimeHome, agentId, agentName) {
    const mod = await import('../cli/telegram-connect.js');
    return agentId
        ? await mod.runTelegramConnectCommand(runtimeHome, agentId, agentName)
        : await mod.runTelegramConnectCommand(runtimeHome);
}
async function runSlackSetup(runtimeHome, agentId, agentName) {
    const mod = await import('../cli/slack.js');
    return agentId
        ? await mod.runSlackConnectCommand(runtimeHome, agentId, agentName)
        : await mod.runSlackConnectCommand(runtimeHome);
}
async function runTeamsSetup(runtimeHome, agentId, agentName) {
    const mod = await import('../cli/teams.js');
    return agentId
        ? await mod.runTeamsConnectCommand(runtimeHome, undefined, agentId, agentName)
        : await mod.runTeamsConnectCommand(runtimeHome);
}
async function runDiscordSetup(runtimeHome, agentId, agentName) {
    const mod = await import('../cli/discord.js');
    return agentId
        ? await mod.runDiscordConnectCommand(runtimeHome, undefined, agentId, agentName)
        : await mod.runDiscordConnectCommand(runtimeHome);
}
function isChannelEnabled(settings, providerId) {
    return settings.providers?.[providerId]?.enabled ?? false;
}
const telegramProvider = {
    id: 'telegram',
    label: 'Telegram',
    jidPrefix: 'tg:',
    folderPrefix: 'telegram_',
    isGroupJid: (jid) => jid.startsWith('tg:-'),
    canStreamToJid: (jid) => jid.startsWith('tg:-'),
    formatting: 'telegram-markdown-v2',
    promptPresentation: {
        label: 'Telegram',
        formattingDescription: 'Telegram renders a limited HTML subset',
        maxMessageGuidance: 'hard message length cap 4096 characters',
        attachmentGuidance: 'outbound workspace file attachments are capped at 25MB',
    },
    isEnabled: (settings) => isChannelEnabled(settings, 'telegram'),
    create: createTelegramBuiltInChannel,
    setup: {
        envKeys: ['TELEGRAM_BOT_TOKEN'],
        describe: () => 'Telegram bot via Bot API',
        run: (ctx) => runBuiltInSetup('Telegram', runTelegramSetup, ctx),
    },
};
const slackProvider = {
    id: 'slack',
    label: 'Slack',
    jidPrefix: 'sl:',
    folderPrefix: 'slack_',
    isGroupJid: () => true,
    formatting: 'mrkdwn',
    promptPresentation: {
        label: 'Slack',
        formattingDescription: 'Slack renders mrkdwn',
        maxMessageGuidance: 'keep single messages under 4000 characters',
        attachmentGuidance: 'outbound workspace file attachments are capped at 25MB',
    },
    isEnabled: (settings) => isChannelEnabled(settings, 'slack'),
    create: createSlackBuiltInChannel,
    setup: {
        envKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
        describe: () => 'Slack Socket Mode',
        run: (ctx) => runBuiltInSetup('Slack', runSlackSetup, ctx),
    },
};
const teamsProvider = {
    id: 'teams',
    label: 'Teams',
    controlCapabilityFlags: ['setup', 'discover', 'runtime-placeholder'],
    jidPrefix: 'teams:',
    folderPrefix: 'teams_',
    isGroupJid: (jid) => jid.startsWith('teams:'),
    formatting: 'markdown-native',
    promptPresentation: {
        label: 'Microsoft Teams',
        formattingDescription: 'Teams renders basic HTML',
        attachmentGuidance: 'outbound workspace file attachments are capped at 25MB',
    },
    isEnabled: (settings) => isChannelEnabled(settings, 'teams'),
    create: createTeamsBuiltInChannel,
    setup: {
        envKeys: ['TEAMS_CLIENT_ID', 'TEAMS_CLIENT_SECRET', 'TEAMS_TENANT_ID'],
        describe: () => 'Microsoft Teams app auth',
        run: (ctx) => runBuiltInSetup('Teams', runTeamsSetup, ctx),
    },
};
const discordProvider = {
    id: 'discord',
    label: 'Discord',
    controlCapabilityFlags: ['setup', 'discover'],
    jidPrefix: 'dc:',
    folderPrefix: 'discord_',
    isGroupJid: (jid) => jid.startsWith('dc:'),
    formatting: 'markdown-native',
    promptPresentation: {
        label: 'Discord',
        formattingDescription: 'Discord renders markdown',
        maxMessageGuidance: 'hard message length cap 2000 characters',
        attachmentGuidance: 'outbound workspace file attachments are capped at 25MB',
    },
    isEnabled: (settings) => isChannelEnabled(settings, 'discord'),
    create: createDiscordBuiltInChannel,
    setup: {
        envKeys: ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID'],
        describe: () => 'Discord bot and application commands',
        run: (ctx) => runBuiltInSetup('Discord', runDiscordSetup, ctx),
    },
};
const appProvider = {
    id: 'app',
    label: 'App',
    internal: true,
    jidPrefix: 'app:',
    folderPrefix: 'app_',
    isGroupJid: () => true,
    formatting: 'none',
    promptPresentation: {
        label: 'embedded app',
        formattingDescription: 'Markdown renders natively',
        maxMessageGuidance: 'no hard message length cap',
        attachmentGuidance: 'outbound workspace file attachments are capped at 25MB',
    },
    isEnabled: () => true,
    create: createAppBuiltInChannel,
    setup: {
        envKeys: [],
        describe: () => 'Internal SDK/app control plane channel',
        run: async () => { },
    },
};
registerProvider(appProvider);
registerProvider(discordProvider);
registerProvider(slackProvider);
registerProvider(teamsProvider);
registerProvider(telegramProvider);
