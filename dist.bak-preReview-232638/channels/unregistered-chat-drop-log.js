export const UNREGISTERED_CHAT_DROP_LOG_INTERVAL_MS = 60_000;
const lastLoggedAt = new Map();
export function shouldLogUnregisteredChatDrop(provider, chatJid, now = Date.now()) {
    const key = `${provider}:${chatJid}`;
    const previous = lastLoggedAt.get(key);
    if (previous !== undefined &&
        now - previous < UNREGISTERED_CHAT_DROP_LOG_INTERVAL_MS) {
        return false;
    }
    lastLoggedAt.set(key, now);
    if (lastLoggedAt.size > 1_000) {
        for (const [candidate, loggedAt] of lastLoggedAt) {
            if (now - loggedAt >= UNREGISTERED_CHAT_DROP_LOG_INTERVAL_MS) {
                lastLoggedAt.delete(candidate);
            }
        }
    }
    return true;
}
