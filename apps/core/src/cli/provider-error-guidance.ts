export const TOKEN_BOUND_HTTP_GUIDANCE =
  'Check token scopes, chat permissions, and network, then retry. Raw token-bearing transport details are intentionally not printed.';

export const TOKEN_BOUND_NETWORK_GUIDANCE =
  'Check internet access and retry. Raw token-bearing transport details are intentionally not printed.';

export function safeSlackErrorCode(error: unknown): string {
  return typeof error === 'string' && /^[a-z_]{1,64}$/.test(error)
    ? error
    : 'unknown_error';
}

export function safeTelegramDescription(
  description: unknown,
  fallback: string,
): string {
  if (typeof description !== 'string') return fallback;
  const value = description.trim();
  if (!value) return fallback;
  if (/https?:|api\.telegram\.org|\/bot|bearer|token/i.test(value)) {
    return fallback;
  }
  return /^(Unauthorized|Forbidden|Bad Request: [A-Za-z0-9 _.,:'"-]{1,96})$/.test(
    value,
  )
    ? value
    : fallback;
}
