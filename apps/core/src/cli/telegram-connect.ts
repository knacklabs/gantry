import * as p from '@clack/prompts';
import '../channels/register-builtins.js';
import { upsertEnvFile } from '../config/env/file.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import { listTelegramRecentChats } from './telegram-chat-discovery.js';
import {
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import {
  normalizeTelegramChatJid,
  readTelegramFromRuntimeEnv,
  registerTelegramMainGroup,
  validateTelegramBotToken,
  verifyTelegramChatAccess,
} from './telegram.js';
import { MAIN_AGENT_NAME } from './main-agent.js';

type TelegramChatChoice =
  | {
      type: 'selected';
      chatJid: string;
      adminSenderId?: string;
    }
  | { type: 'skip' }
  | { type: 'cancel' };

function parseTelegramApproverIds(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

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
  if (!normalized) return { type: 'skip' };

  const adminSenderId = await promptManualTelegramAdminSenderId();
  if (adminSenderId === null) return { type: 'cancel' };
  return adminSenderId
    ? { type: 'selected', chatJid: normalized, adminSenderId }
    : { type: 'selected', chatJid: normalized };
}

async function promptManualTelegramAdminSenderId(): Promise<string | null> {
  const result = await p.text({
    message: 'Telegram sender/user ID for session admin (optional)',
    placeholder:
      'Press Enter to skip; enter only your own trusted Telegram user ID',
    validate: (value) => {
      const trimmed = String(value || '').trim();
      if (!trimmed) return undefined;
      return /^-?\d+$/.test(trimmed)
        ? undefined
        : 'Use a numeric Telegram user ID.';
    },
  });
  if (p.isCancel(result)) return null;
  return String(result || '').trim();
}

function normalizeTelegramPermissionApproverIds(raw: string): string {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^-?\d+$/.test(entry))
    .join(',');
}

async function promptTelegramPermissionApproverIds(
  defaultValue: string,
): Promise<string | null> {
  const result = await p.text({
    message:
      'Telegram admin/approver user IDs for permissions; seeds main_agent DM admin and conversation approvers (required)',
    placeholder: '12345,67890',
    defaultValue,
    validate: (value) => {
      const parsed = normalizeTelegramPermissionApproverIds(
        String(value || '').trim(),
      );
      return parsed
        ? undefined
        : 'Enter one or more numeric Telegram user IDs separated by commas.';
    },
  });
  if (p.isCancel(result)) return null;
  return normalizeTelegramPermissionApproverIds(String(result || '').trim());
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

  spinner.stop(`Found ${discovery.chats.length} recent chats.`);
  const selected = await p.select({
    message: 'Choose the Telegram chat for the Main Agent',
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
  if (!normalized) return { type: 'skip' };
  const selectedChat = discovery.chats.find(
    (chat) => chat.chatJid === normalized,
  );
  const discoveredSender =
    selectedChat?.chatType === 'private'
      ? /^tg:(\d+)$/.exec(selectedChat.chatJid)?.[1]
      : undefined;
  const adminSenderId =
    discoveredSender || (await promptManualTelegramAdminSenderId());
  if (adminSenderId === null) return { type: 'cancel' };
  return adminSenderId
    ? { type: 'selected', chatJid: normalized, adminSenderId }
    : { type: 'selected', chatJid: normalized };
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
  const adminSenderId =
    chatChoice.type === 'selected' ? chatChoice.adminSenderId : undefined;
  let approverInput = '';
  if (normalizedChatJid) {
    const promptedApprovers = await promptTelegramPermissionApproverIds(
      adminSenderId || '',
    );
    if (promptedApprovers === null) {
      p.outro('Telegram connect cancelled.');
      return 1;
    }
    approverInput = promptedApprovers;
  }
  let registeredFolder = '';
  let registeredGroupName = '';

  if (normalizedChatJid) {
    const access = await verifyTelegramChatAccess({
      token: tokenInput,
      chatJid: normalizedChatJid,
      botId: validation.botId,
      sendTestMessage: false,
    });
    if (!access.ok) {
      p.log.error(access.message);
      if (access.nextAction) p.log.info(access.nextAction);
      return 1;
    }

    const registered = await registerTelegramMainGroup({
      runtimeHome,
      chatJid: normalizedChatJid,
      displayName: loadRuntimeSettings(runtimeHome).agent.name,
    });
    registeredFolder = registered.folder;
    registeredGroupName = registered.groupName;

    p.log.success(
      `Registered ${registered.groupName} for Telegram chat ${normalizedChatJid} in folder ${registered.folder}.`,
    );
  }

  upsertEnvFile(envFilePath(runtimeHome), {
    TELEGRAM_BOT_TOKEN: tokenInput,
  });
  const settings = loadRuntimeSettings(runtimeHome);
  settings.providers.telegram.enabled = true;
  if (registeredFolder) {
    const approverIds = parseTelegramApproverIds(
      approverInput || adminSenderId || '',
    );
    ensureConfiguredConversationBinding(settings, {
      agentId: registeredFolder,
      agentName: registeredGroupName || settings.agent.name,
      agentFolder: registeredFolder,
      jid: normalizedChatJid,
      displayName: registeredGroupName || settings.agent.name,
      trigger: `@${registeredGroupName || settings.agent.name}`,
      requiresTrigger: false,
      isMain: true,
      approverIds,
    });
    if (approverIds.length > 0) {
      p.log.success(
        `Enabled session/admin commands and permission approvals for Telegram sender(s) ${approverIds.join(', ')}.`,
      );
    } else {
      p.log.info(
        'No Telegram conversation approver was configured. Run `myclaw provider connect telegram` again and enter your own Telegram user ID if you want chat commands.',
      );
    }
  }
  saveRuntimeSettings(runtimeHome, settings);

  if (normalizedChatJid) {
    p.outro('Telegram conversation is configured and ready.');
  } else {
    p.outro(
      'Telegram token saved. Next: run `myclaw provider connect telegram` to register a conversation.',
    );
  }

  return 0;
}
