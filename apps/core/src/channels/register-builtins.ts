import { ChannelOpts } from './channel-provider.js';
import {
  ChannelProvider,
  ChannelProviderSetupContext,
  registerChannelProvider,
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

function isChannelEnabled(
  settings: ChannelProvider['isEnabled'] extends (settings: infer T) => boolean
    ? T
    : never,
  providerId: string,
): boolean {
  return settings.channels[providerId]?.enabled ?? false;
}

const telegramProvider: ChannelProvider = {
  id: 'telegram',
  label: 'Telegram',
  jidPrefix: 'tg:',
  folderPrefix: 'telegram_',
  isGroupJid: (jid: string) => jid.startsWith('tg:-'),
  formatting: 'telegram-html',
  isEnabled: (settings) => isChannelEnabled(settings, 'telegram'),
  create: createTelegramBuiltInChannel,
  setup: {
    envKeys: ['TELEGRAM_BOT_TOKEN'],
    describe: () => 'Telegram bot via Bot API',
    run: (ctx) => runBuiltInSetup('Telegram', runTelegramSetup, ctx),
  },
};

const slackProvider: ChannelProvider = {
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

registerChannelProvider(slackProvider);
registerChannelProvider(telegramProvider);
