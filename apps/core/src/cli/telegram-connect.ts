import * as p from '@clack/prompts';
import '../channels/register-builtins.js';
import { getChannelProvider } from '../channels/provider-registry.js';
import { upsertEnvFile } from './env-file.js';
import { envFilePath, ensureRuntimeLayout } from './runtime-home.js';
import { listTelegramRecentChats } from './telegram-chat-discovery.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from './runtime-settings.js';
import {
  normalizeTelegramChatJid,
  readTelegramFromRuntimeEnv,
  registerTelegramMainGroup,
  validateTelegramBotToken,
  verifyTelegramChatAccess,
} from './telegram.js';

type TelegramChatChoice =
  | { type: 'selected'; chatJid: string }
  | { type: 'skip' }
  | { type: 'cancel' };

async function promptTelegramToken(
  defaultValue: string,
): Promise<string | null> {
  const result = await p.password({
    message: 'Telegram bot token',
    mask: '*',
    validate: (value) =>
      String(value ?? '').trim() ? undefined : 'Telegram token is required.',
  });
  if (p.isCancel(result)) return null;
  const token = String(result).trim();
  return token || defaultValue.trim() || null;
}

async function promptManualTelegramChatId(
  defaultChatJid = '',
): Promise<TelegramChatChoice> {
  const result = await p.text({
    message: 'Telegram chat ID (optional, e.g. -1001234567890)',
    placeholder: 'Press Enter to skip registration for now',
    defaultValue: defaultChatJid.replace(/^tg:/, ''),
    validate: (value) => {
      const trimmed = String(value || '').trim();
      if (!trimmed) return undefined;
      return normalizeTelegramChatJid(trimmed)
        ? undefined
        : 'Use a numeric Telegram chat ID (for example: -1001234567890).';
    },
  });
  if (p.isCancel(result)) return { type: 'cancel' };
  const normalized = normalizeTelegramChatJid(String(result || '').trim());
  return normalized
    ? { type: 'selected', chatJid: normalized }
    : { type: 'skip' };
}

async function chooseChatFromDiscovery(
  token: string,
): Promise<TelegramChatChoice> {
  const spinner = p.spinner();
  spinner.start('Discovering recent Telegram chats...');
  const discovery = await listTelegramRecentChats({ token, limit: 30 });

  if (!discovery.ok) {
    spinner.stop('Could not auto-discover chats');
    p.log.info(discovery.message);
    if (discovery.nextAction) p.log.info(discovery.nextAction);
    return promptManualTelegramChatId();
  }

  if (discovery.chats.length === 0) {
    spinner.stop('No recent chat found');
    if (discovery.nextAction) p.log.info(discovery.nextAction);
    return promptManualTelegramChatId();
  }

  if (discovery.chats.length === 1) {
    const only = discovery.chats[0];
    spinner.stop(`Auto-selected ${only.chatTitle} (${only.chatJid}).`);
    return { type: 'selected', chatJid: only.chatJid };
  }

  spinner.stop(`Found ${discovery.chats.length} recent chats.`);
  const selected = await p.select({
    message: 'Choose the Telegram chat to register as main',
    options: [
      ...discovery.chats.slice(0, 15).map((chat) => ({
        value: chat.chatJid,
        label: `${chat.chatTitle} (${chat.chatJid.replace(/^tg:/, '')})`,
        hint: chat.chatType,
      })),
      {
        value: 'manual',
        label: 'Enter chat ID manually',
      },
      {
        value: 'skip',
        label: 'Skip chat registration for now',
      },
    ],
  });
  if (p.isCancel(selected)) return { type: 'cancel' };
  if (selected === 'manual') {
    return promptManualTelegramChatId();
  }
  if (selected === 'skip') return { type: 'skip' };
  const normalized = normalizeTelegramChatJid(String(selected || '').trim());
  return normalized
    ? { type: 'selected', chatJid: normalized }
    : { type: 'skip' };
}

export async function runTelegramConnectCommand(
  runtimeHome: string,
): Promise<number> {
  ensureRuntimeLayout(runtimeHome);
  const env = readTelegramFromRuntimeEnv(runtimeHome);
  p.note(
    [
      'Create the bot first: open Telegram, chat with @BotFather, send /newbot, then copy the returned token.',
      'For groups: add the bot to the group and send a message there before discovery.',
      'If MyClaw should see all group messages, make the bot an admin or disable Group Privacy in BotFather with /setprivacy.',
      'Docs: https://core.telegram.org/bots/faq',
    ].join('\n'),
    'Telegram bot setup',
  );

  const tokenInput = await promptTelegramToken(env.token || '');
  if (!tokenInput) {
    p.outro('Telegram connect cancelled.');
    return 1;
  }

  const validation = await validateTelegramBotToken(tokenInput);
  if (!validation.ok) {
    p.log.error(validation.message);
    if (validation.nextAction) p.log.info(validation.nextAction);
    return 1;
  }
  p.log.success(validation.message);

  const chatChoice = await chooseChatFromDiscovery(tokenInput);
  if (chatChoice.type === 'cancel') {
    p.outro('Telegram connect cancelled.');
    return 1;
  }
  const normalizedChatJid =
    chatChoice.type === 'selected' ? chatChoice.chatJid : '';

  if (normalizedChatJid) {
    const access = await verifyTelegramChatAccess({
      token: tokenInput,
      chatJid: normalizedChatJid,
      botId: validation.botId,
      sendTestMessage: true,
    });
    if (!access.ok) {
      p.log.error(access.message);
      if (access.nextAction) p.log.info(access.nextAction);
      return 1;
    }

    const registered = await registerTelegramMainGroup({
      runtimeHome,
      chatJid: normalizedChatJid,
      displayName: access.chatTitle || 'Telegram Main',
    });

    p.log.success(
      `Registered Telegram main group ${registered.groupName} (${normalizedChatJid}) in folder ${registered.folder}.`,
    );
  }

  upsertEnvFile(envFilePath(runtimeHome), {
    TELEGRAM_BOT_TOKEN: tokenInput,
  });
  const settings = loadRuntimeSettings(runtimeHome);
  const provider = getChannelProvider('telegram');
  if (provider && settings.channels[provider.id]) {
    settings.channels[provider.id].enabled = true;
  }
  saveRuntimeSettings(runtimeHome, settings);

  if (normalizedChatJid) {
    p.outro('Telegram channel is configured and ready.');
  } else {
    p.outro(
      'Telegram token saved. Next: run `myclaw agent add <chat-id> --main --requires-trigger false`.',
    );
  }

  return 0;
}
