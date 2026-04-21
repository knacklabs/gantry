import * as p from '@clack/prompts';
import '../channels/register-builtins.js';
import { getChannelProvider } from '../channels/provider-registry.js';
import { upsertEnvFile } from './env-file.js';
import { envFilePath, ensureRuntimeLayout } from './runtime-home.js';
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

export async function runTelegramConnectCommand(
  runtimeHome: string,
): Promise<number> {
  ensureRuntimeLayout(runtimeHome);
  const env = readTelegramFromRuntimeEnv(runtimeHome);

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

  const chatIdInput = await p.text({
    message: 'Telegram chat ID for main group (optional, e.g. -1001234567890)',
    placeholder: 'Press Enter to skip registration now',
    validate: (value) => {
      const trimmed = String(value || '').trim();
      if (!trimmed) return undefined;
      return normalizeTelegramChatJid(trimmed)
        ? undefined
        : 'Use a numeric Telegram chat ID (for example: -1001234567890).';
    },
  });

  if (p.isCancel(chatIdInput)) {
    p.outro('Telegram connect cancelled.');
    return 1;
  }

  const normalizedChatJid = normalizeTelegramChatJid(
    String(chatIdInput || '').trim(),
  );

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
