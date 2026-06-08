export type HostCredentialMode = 'none' | 'gantry';

export function parseHostCredentialMode(
  raw: string | undefined,
): HostCredentialMode | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'none') return 'none';
  if (normalized === 'gantry') return 'gantry';
  return undefined;
}

export function resolveHostCredentialMode(
  rawMode: string | undefined,
): HostCredentialMode {
  const parsed = parseHostCredentialMode(rawMode);
  if (parsed) return parsed;
  return 'gantry';
}
