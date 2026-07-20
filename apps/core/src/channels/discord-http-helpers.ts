import type { DiscordUser } from './discord-types.js';

const DISCORD_RETRY_DELAY_FALLBACK_MS = 1000;
const DISCORD_RETRY_DELAY_MAX_MS = 5000;

export function discordHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bot ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

export function discordReactionEmoji(emoji: string): string {
  if (emoji === 'seen') return '👀';
  if (emoji === 'running') return '⏳';
  return emoji;
}

export function discordRateLimitRetryDelayMs(
  response: Response,
): number | null {
  if (response.status !== 429) return null;
  const retryAfter =
    response.headers.get('retry-after') ??
    response.headers.get('x-ratelimit-reset-after');
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(
        DISCORD_RETRY_DELAY_MAX_MS,
        Math.max(1, Math.round(seconds * 1000)),
      );
    }
  }
  const resetSeconds = Number.parseFloat(
    response.headers.get('x-ratelimit-reset') ?? '',
  );
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    const delayMs = resetSeconds * 1000 - Date.now();
    if (delayMs > 0) {
      return Math.min(DISCORD_RETRY_DELAY_MAX_MS, Math.round(delayMs));
    }
  }
  return DISCORD_RETRY_DELAY_FALLBACK_MS;
}

export async function waitDiscordRetryDelay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export function userName(
  user: DiscordUser | undefined,
  fallback = 'unknown',
): string {
  return user?.username || user?.id || fallback;
}
