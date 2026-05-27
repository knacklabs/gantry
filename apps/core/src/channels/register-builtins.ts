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

async function createInteraktBuiltInChannel(
  opts: ChannelOpts,
): Promise<
  ReturnType<
    (typeof import('./interakt/channel-adapter.js'))['createInteraktChannel']
  >
> {
  const mod = await import('./interakt/channel-adapter.js');
  return mod.createInteraktChannel(opts);
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

const interaktProvider: Provider = {
  id: 'interakt',
  label: 'WhatsApp (Interakt)',
  jidPrefix: 'wa:',
  folderPrefix: 'interakt_',
  // WhatsApp Business B2C is 1:1 in Phase 1.
  isGroupJid: () => false,
  // canStreamToJid omitted: WhatsApp has no progressive-edit concept and
  // Interakt would bill each chunk as a separate session message.
  formatting: 'telegram-html',
  isEnabled: (settings) => isChannelEnabled(settings, 'interakt'),
  create: createInteraktBuiltInChannel,
  setup: {
    envKeys: [
      'INTERAKT_BOT_TOKEN',
      'INTERAKT_WEBHOOK_SECRET',
      'INTERAKT_BUSINESS_PHONE_NUMBER',
    ],
    describe: () =>
      'WhatsApp Business via Interakt aggregator (HTTP API + webhook)',
    run: async () => {
      throw new Error(
        'Interakt CLI setup wizard is not implemented in Phase 1. ' +
          'Set INTERAKT_BOT_TOKEN, INTERAKT_WEBHOOK_SECRET, ' +
          'INTERAKT_BUSINESS_PHONE_NUMBER in <GANTRY_HOME>/.env, set ' +
          'providers.interakt.enabled: true in settings.yaml, and point ' +
          'the Interakt dashboard webhook URL at ' +
          '<public-base>/v1/channels/interakt/webhook.',
      );
    },
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
registerProvider(interaktProvider);
registerProvider(slackProvider);
registerProvider(teamsProvider);
registerProvider(telegramProvider);
