import { safeSlackErrorCode } from './provider-error-guidance.js';

export interface SlackRecentChat {
  chatJid: string;
  chatTitle: string;
  chatType: string;
  isMember?: boolean;
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
      nextAction:
        'Run `gantry provider connect slack` or configure the Slack bot_token runtime secret ref.',
    };
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const limit = Math.max(1, Math.min(200, options.limit ?? 200));
  const excludeArchived = options.includeArchived === true ? 'false' : 'true';

  try {
    const rows: Array<{
      id?: string;
      name?: string;
      user?: string;
      is_im?: boolean;
      is_mpim?: boolean;
      is_private?: boolean;
      is_member?: boolean;
      is_archived?: boolean;
      latest?: { ts?: string };
      updated?: number;
      created?: number;
    }> = [];
    let cursor = '';
    do {
      const url = new URL('https://slack.com/api/conversations.list');
      url.searchParams.set('types', 'public_channel,private_channel,mpim,im');
      url.searchParams.set('exclude_archived', excludeArchived);
      url.searchParams.set('limit', String(limit));
      if (cursor) url.searchParams.set('cursor', cursor);
      let response = await fetchWithTimeout(url.toString(), timeoutMs, {
        headers: { authorization: `Bearer ${botToken}` },
      });
      if (response.status === 429) {
        const requestedDelay = Number(response.headers.get('retry-after'));
        const retryAfter = Math.min(
          60,
          Math.max(0, Number.isFinite(requestedDelay) ? requestedDelay : 1),
        );
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1_000));
        response = await fetchWithTimeout(url.toString(), timeoutMs, {
          headers: { authorization: `Bearer ${botToken}` },
        });
      }
      if (!response.ok) {
        return {
          ok: false,
          chats: [],
          message: `Slack conversations.list failed with HTTP ${response.status}.`,
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
          is_member?: boolean;
          is_archived?: boolean;
          latest?: { ts?: string };
          updated?: number;
          created?: number;
        }>;
        response_metadata?: { next_cursor?: string };
      }>(response);
      if (!payload.ok) {
        return {
          ok: false,
          chats: [],
          message: `Slack conversation discovery failed: ${safeSlackErrorCode(payload.error)}.`,
          nextAction:
            'Ensure the bot has the required conversation scopes and retry.',
        };
      }
      rows.push(...(Array.isArray(payload.channels) ? payload.channels : []));
      cursor = payload.response_metadata?.next_cursor?.trim() || '';
    } while (cursor);

    const dmNames = await slackUserNames(
      botToken,
      timeoutMs,
      rows
        .filter((row) => row.is_im && row.user)
        .map((row) => String(row.user)),
    );
    const chats: SlackRecentChat[] = [];
    for (const row of rows) {
      const normalized = normalizeSlackChatJid(String(row.id || ''));
      if (!normalized) continue;
      const chatType = resolveChatType(row);
      const chatTitle =
        row.name?.trim() ||
        (chatType === 'im'
          ? dmNames.get(String(row.user)) || `dm-${row.user || 'unknown'}`
          : normalized);
      const sourceTs =
        parseTs(row.latest?.ts) || parseTs(row.updated) || parseTs(row.created);
      chats.push({
        chatJid: normalized,
        chatTitle,
        chatType,
        isMember:
          chatType === 'im' || chatType === 'mpim'
            ? true
            : row.is_member === true,
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
          'Create a public channel or invite the app to a private channel, then retry.',
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

async function slackUserNames(
  botToken: string,
  timeoutMs: number,
  userIds: string[],
): Promise<Map<string, string>> {
  const wanted = new Set(userIds);
  const names = new Map<string, string>();
  if (wanted.size === 0) return names;
  let cursor = '';
  try {
    do {
      const url = new URL('https://slack.com/api/users.list');
      url.searchParams.set('limit', '200');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetchWithTimeout(url.toString(), timeoutMs, {
        headers: { authorization: `Bearer ${botToken}` },
      });
      if (!response.ok) return names;
      const payload = await readSlackPayload<{
        members?: Array<{
          id?: string;
          name?: string;
          real_name?: string;
          profile?: { display_name?: string; real_name?: string };
        }>;
        response_metadata?: { next_cursor?: string };
      }>(response);
      if (!payload.ok) return names;
      for (const member of payload.members ?? []) {
        if (!member.id || !wanted.has(member.id)) continue;
        const name =
          member.profile?.display_name?.trim() ||
          member.profile?.real_name?.trim() ||
          member.real_name?.trim() ||
          member.name?.trim();
        if (name) names.set(member.id, name);
      }
      cursor = payload.response_metadata?.next_cursor?.trim() || '';
    } while (cursor && names.size < wanted.size);
  } catch {
    return names;
  }
  return names;
}
