import type { DiscordUser } from './discord-types.js';

const DISCORD_RETRY_DELAY_FALLBACK_MS = 1000;
const DISCORD_RETRY_DELAY_MAX_MS = 5000;

export class DiscordRestError extends Error {
  readonly status: number;
  readonly discordCode: number | undefined;

  constructor(message: string, status: number, discordCode?: number) {
    super(message);
    this.name = 'DiscordRestError';
    this.status = status;
    this.discordCode = discordCode;
  }
}

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

export async function waitDiscordRetryDelay(
  delayMs: number,
  signal?: AbortSignal | null,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function requestDiscordJson<T>(input: {
  url: string;
  init: RequestInit;
  errorMessage: string;
  parseJson?: boolean;
  fetcher?: typeof fetch;
  onRetry?: (attempt: number, retryDelayMs: number) => void;
}): Promise<T> {
  const fetcher = input.fetcher ?? fetch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetcher(input.url, input.init);
    if (response.ok) {
      return input.parseJson === false
        ? (undefined as T)
        : ((await response.json()) as T);
    }
    const discordCode = await readDiscordErrorCode(response);
    const retryDelayMs = discordRateLimitRetryDelayMs(response);
    if (retryDelayMs === null || attempt >= 2) {
      throw new DiscordRestError(
        input.errorMessage,
        response.status,
        discordCode,
      );
    }
    input.onRetry?.(attempt + 1, retryDelayMs);
    await waitDiscordRetryDelay(retryDelayMs, input.init.signal);
  }
  throw new Error(input.errorMessage);
}

async function readDiscordErrorCode(
  response: Response,
): Promise<number | undefined> {
  try {
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return undefined;
    }
    const code = (body as Record<string, unknown>).code;
    return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export function userName(
  user: DiscordUser | undefined,
  fallback = 'unknown',
): string {
  return user?.username || user?.id || fallback;
}
