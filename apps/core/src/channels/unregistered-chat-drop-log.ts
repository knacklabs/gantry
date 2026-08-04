export const UNREGISTERED_CHAT_DROP_LOG_INTERVAL_MS = 60_000;

const lastLoggedAt = new Map<string, number>();

export function shouldLogUnregisteredChatDrop(
  provider: string,
  chatJid: string,
  now = Date.now(),
): boolean {
  const key = `${provider}:${chatJid}`;
  const previous = lastLoggedAt.get(key);
  if (
    previous !== undefined &&
    now - previous < UNREGISTERED_CHAT_DROP_LOG_INTERVAL_MS
  ) {
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
