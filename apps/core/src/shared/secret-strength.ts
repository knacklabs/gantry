export function isStrongProductionSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 32) return false;
  const normalized = trimmed.toLowerCase();
  if (
    ['secret', 'password', 'changeme', 'test', 'dev', 'example'].some((word) =>
      normalized.includes(word),
    )
  ) {
    return false;
  }
  if (new Set(trimmed).size < 8) return false;
  return true;
}
