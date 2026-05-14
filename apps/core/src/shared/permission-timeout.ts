import fs from 'fs';
import path from 'path';
import { getMyclawHome } from './myclaw-home.js';
type PermissionTimeoutContext = 'interactive' | 'autonomous';
const INTERACTIVE_MIN_MS = 10_000;
const INTERACTIVE_DEFAULT_MS = 300_000;
const AUTONOMOUS_DEFAULT_MS = 0;
const INTERACTIVE_KEYS = [
  'MYCLAW_INTERACTIVE_PERMISSION_TIMEOUT_MS',
  'PERMISSION_APPROVAL_TIMEOUT_MS',
  'MYCLAW_PERMISSION_TIMEOUT_MS',
] as const;
const AUTONOMOUS_KEYS = ['MYCLAW_AUTONOMOUS_PERMISSION_TIMEOUT_MS'] as const;
const RUNTIME_ENV_KEYS = new Set<string>([
  ...INTERACTIVE_KEYS,
  ...AUTONOMOUS_KEYS,
]);
let runtimeEnvCache: Record<string, string | undefined> | undefined;
export function getPermissionTimeoutMs(
  context: PermissionTimeoutContext,
  env: Record<string, string | undefined> = process.env,
  fallbackEnv: Record<string, string | undefined> = {},
): number {
  const raw = firstValue(context, env, fallbackEnv, runtimeEnv());
  const defaultMs =
    context === 'interactive' ? INTERACTIVE_DEFAULT_MS : AUTONOMOUS_DEFAULT_MS;
  const parsed = parseInt(raw || String(defaultMs), 10);
  const timeoutMs = Number.isFinite(parsed) ? parsed : defaultMs;
  if (context === 'interactive') {
    return Math.max(INTERACTIVE_MIN_MS, timeoutMs || INTERACTIVE_DEFAULT_MS);
  }
  return Math.max(0, timeoutMs);
}
export function resolvePermissionApprovalTimeoutMs(
  env: Record<string, string | undefined> = process.env,
  fallbackEnv: Record<string, string | undefined> = {},
): number {
  return getPermissionTimeoutMs('interactive', env, fallbackEnv);
}
function firstValue(
  context: PermissionTimeoutContext,
  ...sources: Array<Record<string, string | undefined>>
): string | undefined {
  const keys = context === 'interactive' ? INTERACTIVE_KEYS : AUTONOMOUS_KEYS;
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key]?.trim();
      if (value) return value;
    }
  }
  return undefined;
}
function runtimeEnv(): Record<string, string | undefined> {
  if (runtimeEnvCache) return runtimeEnvCache;
  try {
    const entries = fs
      .readFileSync(path.join(getMyclawHome(), '.env'), 'utf8')
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^([^#=\s]+)\s*=\s*(.*)$/.exec(line.trim());
        return match && RUNTIME_ENV_KEYS.has(match[1])
          ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]]
          : [];
      });
    return (runtimeEnvCache = Object.fromEntries(entries));
  } catch {
    runtimeEnvCache = {};
  }
  return runtimeEnvCache;
}
export const PERMISSION_APPROVAL_TIMEOUT_MS =
  resolvePermissionApprovalTimeoutMs();
