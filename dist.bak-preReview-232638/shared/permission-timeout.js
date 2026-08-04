import fs from 'fs';
import path from 'path';
import { getGantryHome } from './gantry-home.js';
export const NO_PERMISSION_TIMEOUT_MS = 0;
const INTERACTIVE_MIN_MS = 10_000;
const INTERACTIVE_DEFAULT_MS = NO_PERMISSION_TIMEOUT_MS;
const AUTONOMOUS_DEFAULT_MS = NO_PERMISSION_TIMEOUT_MS;
const INTERACTIVE_KEYS = [
    'GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS',
    'PERMISSION_APPROVAL_TIMEOUT_MS',
    'GANTRY_PERMISSION_TIMEOUT_MS',
];
const AUTONOMOUS_KEYS = ['GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS'];
const RUNTIME_ENV_KEYS = new Set([
    ...INTERACTIVE_KEYS,
    ...AUTONOMOUS_KEYS,
]);
let runtimeEnvCache;
export function getPermissionTimeoutMs(context, env = process.env, fallbackEnv = {}) {
    const raw = firstValue(context, env, fallbackEnv, runtimeEnv());
    const defaultMs = context === 'interactive' ? INTERACTIVE_DEFAULT_MS : AUTONOMOUS_DEFAULT_MS;
    const parsed = parseInt(raw || String(defaultMs), 10);
    const timeoutMs = Number.isFinite(parsed) ? parsed : defaultMs;
    if (context === 'interactive') {
        return timeoutMs === NO_PERMISSION_TIMEOUT_MS
            ? NO_PERMISSION_TIMEOUT_MS
            : Math.max(INTERACTIVE_MIN_MS, timeoutMs);
    }
    return Math.max(NO_PERMISSION_TIMEOUT_MS, timeoutMs);
}
export function resolvePermissionApprovalTimeoutMs(env = process.env, fallbackEnv = {}) {
    return getPermissionTimeoutMs('interactive', env, fallbackEnv);
}
function firstValue(context, ...sources) {
    const keys = context === 'interactive' ? INTERACTIVE_KEYS : AUTONOMOUS_KEYS;
    for (const source of sources) {
        for (const key of keys) {
            const value = source[key]?.trim();
            if (value)
                return value;
        }
    }
    return undefined;
}
function runtimeEnv() {
    if (runtimeEnvCache)
        return runtimeEnvCache;
    try {
        const entries = fs
            .readFileSync(path.join(getGantryHome(), '.env'), 'utf8')
            .split(/\r?\n/)
            .flatMap((line) => {
            const match = /^([^#=\s]+)\s*=\s*(.*)$/.exec(line.trim());
            return match && RUNTIME_ENV_KEYS.has(match[1])
                ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]]
                : [];
        });
        return (runtimeEnvCache = Object.fromEntries(entries));
    }
    catch {
        runtimeEnvCache = {};
    }
    return runtimeEnvCache;
}
export const PERMISSION_APPROVAL_TIMEOUT_MS = resolvePermissionApprovalTimeoutMs();
