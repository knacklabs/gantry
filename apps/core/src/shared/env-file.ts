export type EnvMap = Record<string, string>;

function normalizeLine(line: string): string {
  return line.replace(/\r$/, '');
}

export function parseEnvContent(content: string): EnvMap {
  const env: EnvMap = {};
  for (const rawLine of content.split('\n')) {
    const line = normalizeLine(rawLine).trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;
    let value = line.slice(eqIdx + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        const decoded = JSON.parse(value) as unknown;
        if (typeof decoded === 'string') value = decoded;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (
      value.length >= 2 &&
      value.startsWith("'") &&
      value.endsWith("'")
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
