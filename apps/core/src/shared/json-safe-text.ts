export function sanitizeJsonSafeText(value: string): string {
  let output = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isHighSurrogate(code)) {
      const next = value.charCodeAt(i + 1);
      if (isLowSurrogate(next)) {
        output += value[i] + value[i + 1];
        i += 1;
      } else {
        output += '\uFFFD';
      }
      continue;
    }
    if (isLowSurrogate(code)) {
      output += '\uFFFD';
      continue;
    }
    output += value[i];
  }
  return output;
}

export function sanitizeJsonSafeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeJsonSafeText(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonSafeValue);
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = sanitizeJsonSafeValue(item);
  }
  return next;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
