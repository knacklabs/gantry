export type HostCredentialMode = 'env-only' | 'onecli-only' | 'hybrid';

export function parseHostCredentialMode(
  raw: string | undefined,
): HostCredentialMode | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (
    normalized === 'env-only' ||
    normalized === 'onecli-only' ||
    normalized === 'hybrid'
  ) {
    return normalized;
  }
  return undefined;
}

export function resolveHostCredentialMode(
  rawMode: string | undefined,
  onecliUrl: string | undefined,
): HostCredentialMode {
  const parsed = parseHostCredentialMode(rawMode);
  if (parsed) return parsed;
  return onecliUrl?.trim() ? 'hybrid' : 'env-only';
}
