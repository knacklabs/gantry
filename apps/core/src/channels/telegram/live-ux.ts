import { LiveUxRateLimitError } from '../../domain/channel-live-ux.js';

export function telegramReactionEmoji(emoji: string): string {
  if (emoji === 'seen') return '👀';
  if (emoji === 'running') return '⏳';
  return emoji;
}

export const TELEGRAM_LIVE_UX_CAPABILITY = {
  typing: 'expiring',
  reactions: { removal: 'all' },
  canonicalTarget: (
    target:
      | { operation: 'typing'; jid: string; threadId?: string }
      | { operation: 'reaction'; jid: string; messageRef: string },
  ) => ({
    key:
      target.operation === 'typing'
        ? `typing\n${target.jid}\n${target.threadId ?? ''}`
        : `reaction\n${target.jid}\n${target.messageRef}`,
  }),
} as const;

export function translateTelegramLiveUxError(err: unknown): never {
  const candidate = err as {
    error_code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    parameters?: { retry_after?: unknown };
    response?: {
      status?: unknown;
      parameters?: { retry_after?: unknown };
    };
  };
  if (
    candidate.error_code !== 429 &&
    candidate.status !== 429 &&
    candidate.statusCode !== 429 &&
    candidate.response?.status !== 429
  ) {
    throw err;
  }
  const retryAfter =
    candidate.parameters?.retry_after ??
    candidate.response?.parameters?.retry_after;
  const seconds =
    typeof retryAfter === 'number'
      ? retryAfter
      : typeof retryAfter === 'string'
        ? Number.parseFloat(retryAfter)
        : Number.NaN;
  const retryDelayMs =
    Number.isFinite(seconds) && seconds > 0
      ? Math.max(1, Math.round(seconds * 1_000))
      : 1_000;
  throw new LiveUxRateLimitError(retryDelayMs, err);
}
