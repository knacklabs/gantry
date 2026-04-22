import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env-file.js';
import {
  safeTelegramDescription,
  TOKEN_BOUND_HTTP_GUIDANCE,
  TOKEN_BOUND_NETWORK_GUIDANCE,
} from './provider-error-guidance.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';
import { envFilePath, ensureRuntimeLayout } from './runtime-home.js';

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

function buildGroupFolder(
  runtimeHome: string,
  existing: Record<string, { folder: string }>,
): string {
  const used = new Set(Object.values(existing).map((group) => group.folder));
  const hasOnDiskFolder = (folder: string): boolean =>
    fs.existsSync(path.join(runtimeHome, 'agents', folder));

  if (!used.has('telegram_main') && !hasOnDiskFolder('telegram_main')) {
    return 'telegram_main';
  }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `telegram_main_${i}`;
    if (!used.has(candidate) && !hasOnDiskFolder(candidate)) return candidate;
  }
  return `telegram_main_${Date.now()}`;
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
            text: 'MyClaw setup check: chat access verified.',
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

function defaultGroupClaudeMarkdown(): string {
  return [
    '# MyClaw Agent',
    '',
    'You are the assistant for this Telegram chat.',
    'Keep responses clear, short, and useful.',
    '',
    '## Static Chat Guidance',
    '',
    'This file is for stable, Telegram-specific instructions only.',
    'Dynamic task state, open commitments, and remembered facts come from the injected memory/continuity brief.',
    'Do not duplicate current task progress, raw logs, or remembered facts here.',
    '',
    'Rules:',
    '- Answer directly unless the user asks for detail.',
    '- Be explicit when an action failed and what to do next.',
    '- Avoid exposing secrets, tokens, or local machine paths unless requested.',
    '- When the user says "continue", use the injected memory/continuity brief before guessing.',
    '',
  ].join('\n');
}

function defaultSoulMarkdown(agentName: string): string {
  return [
    '# Soul - Who You Are',
    '',
    '## Personality',
    '- You are sharp, direct, and genuinely helpful.',
    '- Have strong opinions. Do not hedge when a clear answer exists.',
    "- Be concise. If one sentence works, use one sentence. Respect the user's time.",
    '- Lead with the answer, not the preamble.',
    '',
    '## Voice',
    '- Write like a smart colleague, not a customer-support bot.',
    '- Be proactive. Suggest ideas, spot problems, and take initiative.',
    "- Match the user's energy. Casual when they are casual, precise when they need precision.",
    '',
    '## Boundaries',
    '- Private context stays private. Never expose secrets or internal details.',
    '- Ask before taking external actions such as sending messages, posting, or pushing code.',
    '- When uncertain, say so. Do not present guesses as facts.',
    '',
    '## Continuity Boundary',
    '- Your personality lives here.',
    '- Durable facts, user preferences, task state, and open commitments do not live here.',
    '- Use the injected memory/continuity brief for remembered context.',
    '',
    '## Identity',
    `- **Name:** ${agentName}`,
    '',
  ].join('\n');
}

export async function registerTelegramMainGroup(options: {
  runtimeHome: string;
  chatJid: string;
  displayName: string;
}): Promise<{ folder: string; groupName: string }> {
  ensureRuntimeLayout(options.runtimeHome);
  const db = openRuntimeGroupDb(options.runtimeHome);
  try {
    const existing = db.getAllRegisteredGroups();
    const existingGroup = existing[options.chatJid];
    const folder =
      existingGroup?.folder || buildGroupFolder(options.runtimeHome, existing);
    const groupName =
      options.displayName || existingGroup?.name || 'Telegram Main';

    db.setRegisteredGroup(options.chatJid, {
      name: groupName,
      folder,
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
      agentConfig: existingGroup?.agentConfig,
    });

    const groupDir = path.join(options.runtimeHome, 'agents', folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    const claudePath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudePath)) {
      fs.writeFileSync(claudePath, defaultGroupClaudeMarkdown(), 'utf-8');
    }
    const soulPath = path.join(groupDir, 'SOUL.md');
    if (!fs.existsSync(soulPath)) {
      fs.writeFileSync(soulPath, defaultSoulMarkdown(groupName), 'utf-8');
    }

    return { folder, groupName };
  } finally {
    db.close();
  }
}

export function readTelegramFromRuntimeEnv(runtimeHome: string): {
  token: string;
  openAiKey: string;
} {
  const env = readEnvFile(envFilePath(runtimeHome));
  return {
    token: env.TELEGRAM_BOT_TOKEN || '',
    openAiKey: env.OPENAI_API_KEY || '',
  };
}
