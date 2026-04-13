import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env-file.js';
import { envFilePath, ensureRuntimeLayout } from './runtime-home.js';

export interface TelegramTokenValidation {
  ok: boolean;
  botId?: number;
  username?: string;
  displayName?: string;
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
      const body = await response.text();
      return {
        ok: false,
        message: `Telegram API returned ${response.status}.`,
        nextAction: `Check your token and try again. Response: ${body.slice(0, 120)}`,
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
        message: payload.description || 'Telegram rejected this token.',
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
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: 'Could not reach Telegram API.',
      nextAction: `Check your internet connection and retry. Details: ${reason}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildGroupFolder(
  existing: Record<string, { folder: string }>,
): string {
  const used = new Set(Object.values(existing).map((group) => group.folder));
  if (!used.has('telegram_main')) return 'telegram_main';
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `telegram_main_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `telegram_main_${Date.now()}`;
}

function defaultGroupClaudeMarkdown(): string {
  return [
    '# MyClaw Group Assistant',
    '',
    'You are the assistant for this Telegram chat.',
    'Keep responses clear, short, and useful.',
    '',
    'Rules:',
    '- Answer directly unless the user asks for detail.',
    '- Be explicit when an action failed and what to do next.',
    '- Avoid exposing secrets, tokens, or local machine paths unless requested.',
    '',
  ].join('\n');
}

export async function registerTelegramMainGroup(options: {
  runtimeHome: string;
  chatJid: string;
  displayName: string;
}): Promise<{ folder: string; groupName: string }> {
  ensureRuntimeLayout(options.runtimeHome);
  process.env.AGENT_ROOT = options.runtimeHome;

  const db = await import('../storage/db.js');
  db.initDatabase();

  const existing = db.getAllRegisteredGroups();
  const existingGroup = existing[options.chatJid];
  const folder = existingGroup?.folder || buildGroupFolder(existing);
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

  const groupDir = path.join(options.runtimeHome, 'groups', folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  const claudePath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudePath)) {
    fs.writeFileSync(claudePath, defaultGroupClaudeMarkdown(), 'utf-8');
  }

  return { folder, groupName };
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
