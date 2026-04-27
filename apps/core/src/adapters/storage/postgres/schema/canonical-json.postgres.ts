export function encode(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function decode<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
