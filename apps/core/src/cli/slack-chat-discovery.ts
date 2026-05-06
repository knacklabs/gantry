import { safeSlackErrorCode } from './provider-error-guidance.js';

export interface SlackRecentChat {
  chatJid: string;
  chatTitle: string;
  chatType: string;
  isArchived?: boolean;
  sourceTs: number;
}

export interface SlackRecentChatsResult {
  ok: boolean;
  chats: SlackRecentChat[];
  message: string;
  nextAction?: string;
}

function normalizeSlackChatJid(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const channelIdRaw = value.startsWith('sl:')
    ? value.slice(3).trim()
    : value.trim();
  if (!/^[A-Za-z][A-Za-z0-9]{7,20}$/.test(channelIdRaw)) {
    return null;
  }
  return `sl:${channelIdRaw.toUpperCase()}`;
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

async function readSlackPayload<T>(
  response: Response,
): Promise<
  { ok?: boolean; error?: string; warning?: string; [key: string]: unknown } & T
> {
  return (await response.json()) as {
    ok?: boolean;
    error?: string;
    warning?: string;
    [key: string]: unknown;
  } & T;
}

function resolveChatType(chat: {
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}): string {
  if (chat.is_im) return 'im';
  if (chat.is_mpim) return 'mpim';
  if (chat.is_private) return 'private_channel';
  return 'public_channel';
}

function parseTs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export async function listSlackRecentChats(options: {
  botToken: string;
  timeoutMs?: number;
  limit?: number;
  includeArchived?: boolean;
}): Promise<SlackRecentChatsResult> {
  const botToken = options.botToken.trim();
  if (!botToken) {
    return {
      ok: false,
      chats: [],
      message: 'Slack bot token is empty.',
      nextAction: 'Set SLACK_BOT_TOKEN before auto-discovery.',
    };
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const limit = Math.max(1, Math.min(200, options.limit ?? 100));
  const excludeArchived = options.includeArchived === true ? 'false' : 'true';

  try {
    const response = await fetchWithTimeout(
      `https://slack.com/api/users.conversations?types=public_channel,private_channel,mpim,im&exclude_archived=${excludeArchived}&limit=${limit}`,
      timeoutMs,
      {
        headers: {
          authorization: `Bearer ${botToken}`,
        },
      },
    );

    if (!response.ok) {
      return {
        ok: false,
        chats: [],
        message: `Slack users.conversations failed with HTTP ${response.status}.`,
        nextAction:
          'Check token scopes/network and retry. Raw token-bearing transport details are intentionally not printed.',
      };
    }

    const payload = await readSlackPayload<{
      channels?: Array<{
        id?: string;
        name?: string;
        user?: string;
        is_im?: boolean;
        is_mpim?: boolean;
        is_private?: boolean;
        is_archived?: boolean;
        latest?: { ts?: string };
        updated?: number;
        created?: number;
      }>;
    }>(response);

    if (!payload.ok) {
      return {
        ok: false,
        chats: [],
        message: `Slack conversation discovery failed: ${safeSlackErrorCode(payload.error)}.`,
        nextAction:
          'Ensure bot has conversations:read and is invited to target channels.',
      };
    }

    const rows = Array.isArray(payload.channels) ? payload.channels : [];
    const chats: SlackRecentChat[] = [];
    for (const row of rows) {
      const normalized = normalizeSlackChatJid(String(row.id || ''));
      if (!normalized) continue;
      const chatType = resolveChatType(row);
      const chatTitle =
        row.name?.trim() ||
        (chatType === 'im' ? `dm-${row.user || 'unknown'}` : normalized);
      const sourceTs =
        parseTs(row.latest?.ts) || parseTs(row.updated) || parseTs(row.created);
      chats.push({
        chatJid: normalized,
        chatTitle,
        chatType,
        ...(row.is_archived === true ? { isArchived: true } : {}),
        sourceTs,
      });
    }

    chats.sort((a, b) => b.sourceTs - a.sourceTs);
    if (chats.length === 0) {
      return {
        ok: true,
        chats: [],
        message: 'No discoverable Slack conversations found for this bot.',
        nextAction:
          'Invite the bot to a channel/DM and rerun `myclaw provider connect slack`.',
      };
    }

    return {
      ok: true,
      chats,
      message: `Discovered ${chats.length} Slack conversation(s).`,
    };
  } catch {
    return {
      ok: false,
      chats: [],
      message: 'Could not reach Slack API for conversation discovery.',
      nextAction:
        'Check internet access and retry. Raw token-bearing transport details are intentionally not printed.',
    };
  }
}
