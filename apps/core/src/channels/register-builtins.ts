import type { ChannelAdapter, ChannelOpts } from './channel-provider.js';
import {
  Provider,
  ChannelProviderSetupContext,
  registerProvider,
} from './provider-registry.js';

async function createTelegramBuiltInChannel(
  opts: ChannelOpts,
): Promise<ChannelAdapter | null> {
  const mod = await import('./telegram.js');
  return await mod.createTelegramChannel(opts);
}

async function createSlackBuiltInChannel(
  opts: ChannelOpts,
): Promise<ChannelAdapter | null> {
  const mod = await import('./slack.js');
  return await mod.createSlackChannel(opts);
}

async function createTeamsBuiltInChannel(
  opts: ChannelOpts,
): Promise<ChannelAdapter | null> {
  const mod = await import('./teams.js');
  return await mod.createTeamsChannel(opts);
}

async function createDiscordBuiltInChannel(
  opts: ChannelOpts,
): Promise<import('./channel-provider.js').ChannelAdapter | null> {
  const mod = await import('./discord.js');
  return await mod.createDiscordChannel(opts);
}

async function createAppBuiltInChannel(
  opts: ChannelOpts,
): Promise<import('./channel-provider.js').ChannelAdapter | null> {
  const mod = await import('./app.js');
  return await mod.createAppChannel(opts);
}

async function runBuiltInSetup(
  providerLabel: string,
  setup: (
    runtimeHome: string,
    agentId?: string,
    agentName?: string,
  ) => Promise<number>,
  ctx: ChannelProviderSetupContext,
): Promise<void> {
  const code = await setup(ctx.runtimeHome, ctx.agentId, ctx.agentName);
  if (code !== 0) {
    throw new Error(
      `${providerLabel} connect command exited with status ${code}`,
    );
  }
}

async function runTelegramSetup(
  runtimeHome: string,
  agentId?: string,
  agentName?: string,
): Promise<number> {
  const mod = await import('../cli/telegram-connect.js');
  return agentId
    ? await mod.runTelegramConnectCommand(runtimeHome, agentId, agentName)
    : await mod.runTelegramConnectCommand(runtimeHome);
}

async function runSlackSetup(
  runtimeHome: string,
  agentId?: string,
  agentName?: string,
): Promise<number> {
  const mod = await import('../cli/slack.js');
  return agentId
    ? await mod.runSlackConnectCommand(runtimeHome, agentId, agentName)
    : await mod.runSlackConnectCommand(runtimeHome);
}

async function runTeamsSetup(
  runtimeHome: string,
  agentId?: string,
  agentName?: string,
): Promise<number> {
  const mod = await import('../cli/teams.js');
  return agentId
    ? await mod.runTeamsConnectCommand(
        runtimeHome,
        undefined,
        agentId,
        agentName,
      )
    : await mod.runTeamsConnectCommand(runtimeHome);
}

async function runDiscordSetup(
  runtimeHome: string,
  agentId?: string,
  agentName?: string,
): Promise<number> {
  const mod = await import('../cli/discord.js');
  return agentId
    ? await mod.runDiscordConnectCommand(
        runtimeHome,
        undefined,
        agentId,
        agentName,
      )
    : await mod.runDiscordConnectCommand(runtimeHome);
}

function isChannelEnabled(
  settings: Provider['isEnabled'] extends (settings: infer T) => boolean
    ? T
    : never,
  providerId: string,
): boolean {
  return settings.providers?.[providerId]?.enabled ?? false;
}

const telegramProvider: Provider = {
  id: 'telegram',
  label: 'Telegram',
  jidPrefix: 'tg:',
  folderPrefix: 'telegram_',
  isGroupJid: (jid: string) => jid.startsWith('tg:-'),
  canStreamToJid: (jid: string) => jid.startsWith('tg:-'),
  formatting: 'telegram-markdown-v2',
  isEnabled: (settings) => isChannelEnabled(settings, 'telegram'),
  create: createTelegramBuiltInChannel,
  setup: {
    envKeys: ['TELEGRAM_BOT_TOKEN'],
    describe: () => 'Telegram bot via Bot API',
    run: (ctx) => runBuiltInSetup('Telegram', runTelegramSetup, ctx),
  },
};

const slackProvider: Provider = {
  id: 'slack',
  label: 'Slack',
  jidPrefix: 'sl:',
  folderPrefix: 'slack_',
  isGroupJid: () => true,
  formatting: 'mrkdwn',
  isEnabled: (settings) => isChannelEnabled(settings, 'slack'),
  create: createSlackBuiltInChannel,
  setup: {
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
    describe: () => 'Slack Socket Mode',
    run: (ctx) => runBuiltInSetup('Slack', runSlackSetup, ctx),
  },
};

const teamsProvider: Provider = {
  id: 'teams',
  label: 'Teams',
  controlCapabilityFlags: ['setup', 'discover', 'bot-framework-runtime'],
  jidPrefix: 'teams:',
  folderPrefix: 'teams_',
  isGroupJid: (jid: string) => jid.startsWith('teams:'),
  formatting: 'markdown-native',
  isEnabled: (settings) => isChannelEnabled(settings, 'teams'),
  create: createTeamsBuiltInChannel,
  setup: {
    envKeys: [
      'TEAMS_CLIENT_ID',
      'TEAMS_CLIENT_SECRET',
      'TEAMS_TENANT_ID',
      'TEAMS_BOT_APP_ID',
      'TEAMS_BOT_APP_PASSWORD',
    ],
    describe: () => 'Microsoft Teams Graph discovery and Bot Framework',
    run: (ctx) => runBuiltInSetup('Teams', runTeamsSetup, ctx),
  },
};

const discordProvider: Provider = {
  id: 'discord',
  label: 'Discord',
  controlCapabilityFlags: ['setup', 'discover'],
  jidPrefix: 'dc:',
  folderPrefix: 'discord_',
  isGroupJid: (jid: string) => jid.startsWith('dc:'),
  formatting: 'markdown-native',
  isEnabled: (settings) => isChannelEnabled(settings, 'discord'),
  create: createDiscordBuiltInChannel,
  setup: {
    envKeys: ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID'],
    describe: () => 'Discord bot and application commands',
    run: (ctx) => runBuiltInSetup('Discord', runDiscordSetup, ctx),
  },
};

const appProvider: Provider = {
  id: 'app',
  label: 'App',
  internal: true,
  jidPrefix: 'app:',
  folderPrefix: 'app_',
  isGroupJid: () => true,
  formatting: 'none',
  isEnabled: () => true,
  create: createAppBuiltInChannel,
  setup: {
    envKeys: [],
    describe: () => 'Internal SDK/app control plane channel',
    run: async () => {},
  },
};

registerProvider(appProvider);
registerProvider(discordProvider);
registerProvider(slackProvider);
registerProvider(teamsProvider);
registerProvider(telegramProvider);
