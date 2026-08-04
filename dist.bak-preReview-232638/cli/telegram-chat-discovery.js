import { normalizeTelegramChatJid } from './telegram.js';
import { safeTelegramDescription } from './provider-error-guidance.js';
async function readTelegramPayload(response) {
    return (await response.json());
}
async function fetchWithTimeout(url, timeoutMs, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...(init || {}),
            signal: controller.signal,
        });
    }
    finally {
        clearTimeout(timeout);
    }
}
function parseTelegramChatFromUpdate(update) {
    if (!update || typeof update !== 'object') {
        return { updateId: 0 };
    }
    const row = update;
    const updateId = typeof row.update_id === 'number' && Number.isFinite(row.update_id)
        ? row.update_id
        : 0;
    const messageLike = row.message ||
        row.edited_message ||
        row.channel_post ||
        row.edited_channel_post;
    if (!messageLike || typeof messageLike !== 'object') {
        return { updateId };
    }
    const message = messageLike;
    const chatRaw = message.chat;
    if (!chatRaw || typeof chatRaw !== 'object') {
        return { updateId };
    }
    const chat = chatRaw;
    const senderRaw = message.from;
    const sender = senderRaw && typeof senderRaw === 'object'
        ? senderRaw
        : undefined;
    return { updateId, chat, sender };
}
function formatTelegramChatTitle(candidate, fallback) {
    const fullName = [candidate.first_name || '', candidate.last_name || '']
        .join(' ')
        .trim();
    return (candidate.title?.trim() ||
        candidate.username?.trim() ||
        fullName ||
        fallback);
}
function formatTelegramSenderName(candidate, fallback) {
    const fullName = [candidate.first_name || '', candidate.last_name || '']
        .join(' ')
        .trim();
    return fullName || candidate.username?.trim() || fallback;
}
export async function listTelegramRecentChats(options) {
    const token = options.token.trim();
    if (!token) {
        return {
            ok: false,
            chats: [],
            message: 'Telegram token is empty.',
            nextAction: 'Run `gantry provider connect telegram` or configure the Telegram bot_token runtime secret ref.',
        };
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const allowedUpdates = encodeURIComponent(JSON.stringify([
        'message',
        'edited_message',
        'channel_post',
        'edited_channel_post',
    ]));
    try {
        const response = await fetchWithTimeout(`https://api.telegram.org/bot${token}/getUpdates?limit=${limit}&allowed_updates=${allowedUpdates}`, timeoutMs);
        if (!response.ok) {
            return {
                ok: false,
                chats: [],
                message: `Telegram getUpdates failed with HTTP ${response.status}.`,
                nextAction: 'Check bot token/network and retry. Raw token-bearing transport details are intentionally not printed.',
            };
        }
        const payload = await readTelegramPayload(response);
        if (!payload.ok || !Array.isArray(payload.result)) {
            return {
                ok: false,
                chats: [],
                message: safeTelegramDescription(payload.description, 'Telegram did not return update history.'),
                nextAction: 'Send a message in the target chat to the bot, then retry Telegram connect.',
            };
        }
        const byJid = new Map();
        for (const update of payload.result) {
            const parsed = parseTelegramChatFromUpdate(update);
            if (!parsed.chat)
                continue;
            const chatIdRaw = String(parsed.chat.id ?? '').trim();
            const chatJid = normalizeTelegramChatJid(chatIdRaw);
            if (!chatJid)
                continue;
            const candidate = {
                chatJid,
                chatTitle: formatTelegramChatTitle(parsed.chat, chatJid),
                chatType: String(parsed.chat.type || 'unknown'),
                username: parsed.chat.username || undefined,
                lastSenderId: parsed.sender?.id !== undefined
                    ? String(parsed.sender.id).trim()
                    : undefined,
                lastSenderName: parsed.sender
                    ? formatTelegramSenderName(parsed.sender, '')
                    : undefined,
                sourceUpdateId: parsed.updateId,
            };
            const previous = byJid.get(chatJid);
            if (!previous || candidate.sourceUpdateId > previous.sourceUpdateId) {
                byJid.set(chatJid, candidate);
            }
        }
        const chats = [...byJid.values()].sort((a, b) => b.sourceUpdateId - a.sourceUpdateId);
        if (chats.length === 0) {
            return {
                ok: true,
                chats: [],
                message: 'No recent chats found in bot updates.',
                nextAction: 'Send a message to the bot in the target chat, then run Telegram connect again.',
            };
        }
        return {
            ok: true,
            chats,
            message: `Discovered ${chats.length} recent Telegram chat(s).`,
        };
    }
    catch {
        return {
            ok: false,
            chats: [],
            message: 'Could not reach Telegram API for chat discovery.',
            nextAction: 'Check internet access and retry. Raw token-bearing transport details are intentionally not printed.',
        };
    }
}
