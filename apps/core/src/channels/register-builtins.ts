import { ChannelOpts } from './channel-provider.js';
import {
  Provider,
  ChannelProviderSetupContext,
  registerProvider,
} from './provider-registry.js';

async function createTelegramBuiltInChannel(
  opts: ChannelOpts,
): Promise<
  ReturnType<(typeof import('./telegram.js'))['createTelegramChannel']>
> {
  const mod = await import('./telegram.js');
  return mod.createTelegramChannel(opts);
}

async function createSlackBuiltInChannel(
  opts: ChannelOpts,
): Promise<ReturnType<(typeof import('./slack.js'))['createSlackChannel']>> {
  const mod = await import('./slack.js');
  return mod.createSlackChannel(opts);
}

async function createTeamsBuiltInChannel(
  opts: ChannelOpts,
): Promise<ReturnType<(typeof import('./teams.js'))['createTeamsChannel']>> {
  const mod = await import('./teams.js');
  return mod.createTeamsChannel(opts);
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
  setup: (runtimeHome: string) => Promise<number>,
  ctx: ChannelProviderSetupContext,
): Promise<void> {
  const code = await setup(ctx.runtimeHome);
  if (code !== 0) {
    throw new Error(
      `${providerLabel} connect command exited with status ${code}`,
    );
  }
}

async function runTelegramSetup(runtimeHome: string): Promise<number> {
  const mod = await import('../cli/telegram-connect.js');
  return await mod.runTelegramConnectCommand(runtimeHome);
}

async function runSlackSetup(runtimeHome: string): Promise<number> {
  const mod = await import('../cli/slack.js');
  return await mod.runSlackConnectCommand(runtimeHome);
}

async function runTeamsSetup(runtimeHome: string): Promise<number> {
  const mod = await import('../cli/teams.js');
  return await mod.runTeamsConnectCommand(runtimeHome);
}

async function runDiscordSetup(runtimeHome: string): Promise<number> {
  const mod = await import('../cli/discord.js');
  return await mod.runDiscordConnectCommand(runtimeHome);
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
  formatting: 'telegram-html',
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
  controlCapabilityFlags: ['setup', 'discover', 'runtime-placeholder'],
  jidPrefix: 'teams:',
  folderPrefix: 'teams_',
  isGroupJid: (jid: string) => jid.startsWith('teams:'),
  formatting: 'markdown-native',
  isEnabled: (settings) => isChannelEnabled(settings, 'teams'),
  create: createTeamsBuiltInChannel,
  setup: {
    envKeys: ['TEAMS_CLIENT_ID', 'TEAMS_CLIENT_SECRET', 'TEAMS_TENANT_ID'],
    describe: () => 'Microsoft Teams app auth',
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
