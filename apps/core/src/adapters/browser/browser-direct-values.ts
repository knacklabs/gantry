export function browserClickModifiers(
  value: unknown,
): Array<'Alt' | 'Control' | 'Meta' | 'Shift'> {
  const allowed = new Set(['Alt', 'Control', 'Meta', 'Shift']);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is 'Alt' | 'Control' | 'Meta' | 'Shift' =>
      typeof item === 'string' && allowed.has(item),
  );
}

export function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}
