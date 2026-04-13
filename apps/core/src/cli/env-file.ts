import fs from 'fs';
import path from 'path';

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
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function readEnvFile(filePath: string): EnvMap {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseEnvContent(content);
  } catch {
    return {};
  }
}

function encodeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function writeEnvFile(filePath: string, env: EnvMap): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = Object.keys(env)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${encodeEnvValue(env[key])}`);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
}

export function upsertEnvFile(
  filePath: string,
  updates: Record<string, string | null | undefined>,
): EnvMap {
  const existing = readEnvFile(filePath);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === '') {
      delete existing[key];
      continue;
    }
    existing[key] = value;
  }
  writeEnvFile(filePath, existing);
  return existing;
}
