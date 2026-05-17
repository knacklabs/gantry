import { readEnvFile } from '../config/env/file.js';
import {
  safeTelegramDescription,
  TOKEN_BOUND_HTTP_GUIDANCE,
  TOKEN_BOUND_NETWORK_GUIDANCE,
} from './provider-error-guidance.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import {
  allocateDefaultAgentFolder,
  defaultTriggerForAgentName,
  normalizeDefaultAgentName,
} from './main-agent.js';
import { syncConfiguredConversationBinding } from './group-helpers.js';
import { nowIso } from '../shared/time/datetime.js';
import { PromptProfileService } from '../application/agents/prompt-profile-service.js';

export interface TelegramTokenValidation {
  ok: boolean;
  botId?: number;
  username?: string;
  displayName?: string;
  message: string;
  nextAction?: string;
}

export interface TelegramChatAccessValidation {
  ok: boolean;
  chatTitle?: string;
  sentTestMessage?: boolean;
  message: string;
  nextAction?: string;
}

export function normalizeTelegramChatJid(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('tg:')) {
    const id = value.slice(3).trim();
    if (!/^[-]?[0-9]+$/.test(id)) return null;
    return `tg:${id}`;
  }
  if (!/^[-]?[0-9]+$/.test(value)) return null;
  return `tg:${value}`;
}

export async function validateTelegramBotToken(
  token: string,
  timeoutMs = 10_000,
): Promise<TelegramTokenValidation> {
  const trimmed = token.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: 'Telegram token is empty.',
      nextAction: 'Paste the bot token from BotFather.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${trimmed}/getMe`,
      { signal: controller.signal },
    );

    if (!response.ok) {
      return {
        ok: false,
        message: `Telegram API returned ${response.status}.`,
        nextAction: TOKEN_BOUND_HTTP_GUIDANCE,
      };
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      result?: { id?: number; username?: string; first_name?: string };
      description?: string;
    };

    if (!payload.ok || !payload.result?.id) {
      return {
        ok: false,
        message: safeTelegramDescription(
          payload.description,
          'Telegram rejected this token.',
        ),
        nextAction: 'Generate a fresh token in BotFather and retry.',
      };
    }

    const username = payload.result.username || '';
    const displayName = payload.result.first_name || username || 'Telegram Bot';
    return {
      ok: true,
      botId: payload.result.id,
      username,
      displayName,
      message: `Connected to @${username || 'bot'} (${payload.result.id}).`,
    };
  } catch {
    return {
      ok: false,
      message: 'Could not reach Telegram API.',
      nextAction: TOKEN_BOUND_NETWORK_GUIDANCE,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readTelegramPayload<T>(
  response: Response,
): Promise<{ ok?: boolean; result?: T; description?: string }> {
  return (await response.json()) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: Omit<RequestInit, 'signal'>,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...(init || {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyTelegramChatAccess(options: {
  token: string;
  chatJid: string;
  botId?: number;
  sendTestMessage?: boolean;
  timeoutMs?: number;
}): Promise<TelegramChatAccessValidation> {
  const token = options.token.trim();
  if (!token) {
    return {
      ok: false,
      message: 'Telegram token is empty.',
      nextAction: 'Set TELEGRAM_BOT_TOKEN before checking chat access.',
    };
  }

  const normalizedJid = normalizeTelegramChatJid(options.chatJid);
  if (!normalizedJid) {
    return {
      ok: false,
      message: 'Invalid Telegram chat ID format.',
      nextAction:
        'Use a numeric Telegram chat ID (for example: -1001234567890).',
    };
  }

  const chatId = normalizedJid.slice(3);
  const timeoutMs = options.timeoutMs ?? 10_000;

  try {
    const getChatResponse = await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`,
      timeoutMs,
    );

    if (!getChatResponse.ok) {
      return {
        ok: false,
        message: `Telegram getChat failed with HTTP ${getChatResponse.status}.`,
        nextAction: TOKEN_BOUND_HTTP_GUIDANCE,
      };
    }

    const chatPayload = await readTelegramPayload<{
      id?: number;
      title?: string;
      username?: string;
      first_name?: string;
      type?: string;
    }>(getChatResponse);

    if (!chatPayload.ok || !chatPayload.result?.id) {
      return {
        ok: false,
        message: safeTelegramDescription(
          chatPayload.description,
          'Telegram could not resolve this chat.',
        ),
        nextAction:
          'Add the bot to the chat and grant message permission, then retry.',
      };
    }

    const chatTitle =
      chatPayload.result.title ||
      chatPayload.result.username ||
      chatPayload.result.first_name ||
      normalizedJid;

    if (options.botId) {
      const getMemberResponse = await fetchWithTimeout(
        `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${options.botId}`,
        timeoutMs,
      );
      if (!getMemberResponse.ok) {
        return {
          ok: false,
          chatTitle,
          message: `Telegram getChatMember failed with HTTP ${getMemberResponse.status}.`,
          nextAction: TOKEN_BOUND_HTTP_GUIDANCE,
        };
      }
      const memberPayload = await readTelegramPayload<{
        status?: string;
      }>(getMemberResponse);
      if (!memberPayload.ok) {
        return {
          ok: false,
          chatTitle,
          message: safeTelegramDescription(
            memberPayload.description,
            'Telegram could not verify bot membership in this chat.',
          ),
          nextAction:
            'Ensure the bot has access to this chat and can read/write messages.',
        };
      }
      const status = (memberPayload.result?.status || '').toLowerCase();
      if (status === 'left' || status === 'kicked') {
        return {
          ok: false,
          chatTitle,
          message: 'Bot is not an active member of this chat.',
          nextAction: 'Add the bot back to this chat and retry.',
        };
      }
    }

    const shouldSendProbe = options.sendTestMessage === true;
    if (shouldSendProbe) {
      const sendResponse = await fetchWithTimeout(
        `https://api.telegram.org/bot${token}/sendMessage`,
        timeoutMs,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: 'Gantry setup check: chat access verified.',
            disable_notification: true,
          }),
        },
      );
      if (!sendResponse.ok) {
        return {
          ok: false,
          chatTitle,
          message: `Telegram sendMessage failed with HTTP ${sendResponse.status}.`,
          nextAction: TOKEN_BOUND_HTTP_GUIDANCE,
        };
      }
      const sendPayload = await readTelegramPayload<{ message_id?: number }>(
        sendResponse,
      );
      if (!sendPayload.ok || !sendPayload.result?.message_id) {
        return {
          ok: false,
          chatTitle,
          message: safeTelegramDescription(
            sendPayload.description,
            'Telegram rejected the setup test message.',
          ),
          nextAction:
            'Grant the bot permission to post in this chat and retry.',
        };
      }
    }

    return {
      ok: true,
      chatTitle,
      sentTestMessage: shouldSendProbe,
      message: shouldSendProbe
        ? `Chat access verified for ${chatTitle}; test message sent.`
        : `Chat access verified for ${chatTitle}.`,
    };
  } catch {
    return {
      ok: false,
      message: 'Could not reach Telegram API for chat verification.',
      nextAction: TOKEN_BOUND_NETWORK_GUIDANCE,
    };
  }
}

export async function registerTelegramMainGroup(options: {
  runtimeHome: string;
  chatJid: string;
  displayName: string;
}): Promise<{ folder: string; groupName: string }> {
  ensureRuntimeLayout(options.runtimeHome);
  const db = await openRuntimeGroupDb(options.runtimeHome);
  try {
    const existing = await db.getAllConversationRoutes();
    const existingGroup = existing[options.chatJid];
    const folder =
      existingGroup?.folder ||
      allocateDefaultAgentFolder(options.runtimeHome, existing);
    const groupName = normalizeDefaultAgentName(options.displayName);

    const route = {
      name: groupName,
      folder,
      trigger: existingGroup?.trigger || defaultTriggerForAgentName(groupName),
      added_at: nowIso(),
      requiresTrigger: false,
      agentConfig: existingGroup?.agentConfig,
    };
    await db.setConversationRoute(options.chatJid, route);
    syncConfiguredConversationBinding({
      runtimeHome: options.runtimeHome,
      agentId: folder,
      agentName: groupName,
      agentFolder: folder,
      jid: options.chatJid,
      displayName: options.displayName,
      trigger: route.trigger,
      requiresTrigger: false,
    });

    await new PromptProfileService({
      fileArtifactStore: () => db.getFileArtifactStore(),
    }).ensureAgentDefaults({ agentFolder: folder, agentName: groupName });

    return { folder, groupName };
  } finally {
    await db.close();
  }
}

export function readTelegramFromRuntimeEnv(runtimeHome: string): {
  token: string;
} {
  const env = readEnvFile(envFilePath(runtimeHome));
  return {
    token: env.TELEGRAM_BOT_TOKEN || '',
  };
}
