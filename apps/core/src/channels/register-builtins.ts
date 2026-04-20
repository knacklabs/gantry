import { ChannelOpts } from './channel-provider.js';
import {
  ChannelProvider,
  ChannelProviderSetupContext,
  registerChannelProvider,
} from './provider-registry.js';

async function loadTelegramProvider(): Promise<ChannelProvider> {
  const mod = await import('./telegram.js');
  return mod.telegramProvider;
}

async function loadSlackProvider(): Promise<ChannelProvider> {
  const mod = await import('./slack.js');
  return mod.slackProvider;
}

async function createBuiltInChannel(
  loadProvider: () => Promise<ChannelProvider>,
  opts: ChannelOpts,
): Promise<Awaited<ReturnType<ChannelProvider['create']>>> {
  const provider = await loadProvider();
  return await provider.create(opts);
}

async function runBuiltInSetup(
  setup: (runtimeHome: string) => Promise<number>,
  ctx: ChannelProviderSetupContext,
): Promise<void> {
  const code = await setup(ctx.runtimeHome);
  if (code !== 0) {
    throw new Error('Channel setup did not complete successfully');
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
  create: (opts) => createBuiltInChannel(loadTelegramProvider, opts),
  setup: {
    envKeys: ['TELEGRAM_BOT_TOKEN'],
    describe: () => 'Telegram bot via Bot API',
    run: (ctx) => runBuiltInSetup(runTelegramSetup, ctx),
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
  create: (opts) => createBuiltInChannel(loadSlackProvider, opts),
  setup: {
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
    describe: () => 'Slack Socket Mode',
    run: (ctx) => runBuiltInSetup(runSlackSetup, ctx),
  },
};

registerChannelProvider(slackProvider);
registerChannelProvider(telegramProvider);
