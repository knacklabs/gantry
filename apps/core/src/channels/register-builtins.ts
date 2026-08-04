import type { ChannelAdapter, ChannelOpts } from './channel-provider.js';
import {
  Provider,
  ChannelProviderSetupContext,
  registerProvider,
} from './provider-registry.js';
import { MAX_MESSAGE_FILE_ATTACHMENT_BYTES } from '../application/core-tools/message-limits.js';
import {
  DISCORD_FILE_MAX_BYTES,
  DISCORD_MESSAGE_MAX_LENGTH,
} from './discord-limits.js';
import { SLACK_FALLBACK_CHUNK_MAX_LENGTH } from './slack/text-limits.js';
import {
  TEAMS_413_RETRY_MAX_BYTES,
  TEAMS_HARD_MESSAGE_BYTES,
  TEAMS_SOFT_MESSAGE_BYTES,
} from './teams-limits.js';
import { TELEGRAM_MESSAGE_MAX_LENGTH } from './telegram/text-limits.js';

const questionGuidance =
  'ask_user_question renders 1-4 questions with 2-4 options each; use a normal message for open-ended input.';
const attachmentCapGuidance = `send_message files are capped at ${MAX_MESSAGE_FILE_ATTACHMENT_BYTES} bytes.`;
const attachmentPresentationGuidance = `outbound workspace file attachments are capped at ${MAX_MESSAGE_FILE_ATTACHMENT_BYTES / 1024 / 1024}MB`;

async function createTelegramBuiltInChannel(
  opts: ChannelOpts,
): Promise<ChannelAdapter | null> {
  const mod = await import('./telegram/channel-adapter.js');
  return await mod.createTelegramChannel(opts);
}

async function createSlackBuiltInChannel(
  opts: ChannelOpts,
): Promise<ChannelAdapter | null> {
  const mod = await import('./slack/channel-adapter.js');
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
  promptPresentation: {
    label: 'Telegram',
    formattingDescription: 'Telegram renders a limited HTML subset',
    maxMessageGuidance: `hard message length cap ${TELEGRAM_MESSAGE_MAX_LENGTH} characters`,
    attachmentGuidance: attachmentPresentationGuidance,
    toolGuidance: [
      `send_message splits oversized text at ${TELEGRAM_MESSAGE_MAX_LENGTH} characters; ${attachmentCapGuidance}`,
      'render_* uses Telegram HTML plus inline keyboards and falls back to plain text when rich rendering fails.',
      questionGuidance,
    ],
  },
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
  promptPresentation: {
    label: 'Slack',
    formattingDescription: 'Slack renders mrkdwn',
    maxMessageGuidance: `keep single messages under ${SLACK_FALLBACK_CHUNK_MAX_LENGTH} characters`,
    attachmentGuidance: attachmentPresentationGuidance,
    toolGuidance: [
      `send_message splits fallback text at ${SLACK_FALLBACK_CHUNK_MAX_LENGTH} characters; ${attachmentCapGuidance}`,
      'render_* uses Block Kit and falls back to plain text when rich rendering fails.',
      questionGuidance,
      'Slack affinity tools: canvas_read, canvas_create, and canvas_update. Read first, keep the returned handle, then edit with canvas_update.',
    ],
  },
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
  promptPresentation: {
    label: 'Microsoft Teams',
    formattingDescription: 'Teams renders basic HTML',
    attachmentGuidance: attachmentPresentationGuidance,
    toolGuidance: [
      `send_message splits near ${TEAMS_SOFT_MESSAGE_BYTES} bytes, enforces ${TEAMS_HARD_MESSAGE_BYTES} code units, and retries 413 responses below ${TEAMS_413_RETRY_MAX_BYTES} bytes; ${attachmentCapGuidance}`,
      'render_* uses an Adaptive Card and falls back to plain text when rich rendering fails.',
      questionGuidance,
    ],
  },
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
  promptPresentation: {
    label: 'Discord',
    formattingDescription: 'Discord renders markdown',
    maxMessageGuidance: `hard message length cap ${DISCORD_MESSAGE_MAX_LENGTH} characters`,
    attachmentGuidance: attachmentPresentationGuidance,
    toolGuidance: [
      `send_message splits oversized text at ${DISCORD_MESSAGE_MAX_LENGTH} characters and rejects files above ${DISCORD_FILE_MAX_BYTES} bytes.`,
      'render_* uses a single embed and falls back to plain text when rich rendering fails.',
      questionGuidance,
      'attachment_open cannot fetch ephemeral Discord attachments; ask the user to upload a durable copy.',
    ],
  },
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
  promptPresentation: {
    label: 'embedded app',
    formattingDescription: 'Markdown renders natively',
    maxMessageGuidance: 'no hard message length cap',
    attachmentGuidance: attachmentPresentationGuidance,
    toolGuidance: [
      `send_message emits one app session event with no provider text cap; ${attachmentCapGuidance}`,
      'render_* emits a structured app descriptor with fallback text.',
      questionGuidance,
    ],
  },
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
