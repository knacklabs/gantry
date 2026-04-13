import fs from 'fs';
import os from 'os';
import path from 'path';

export const DEFAULT_RUNTIME_HOME = path.join(os.homedir(), 'myclaw');
const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.config', 'myclaw');
const RUNTIME_HOME_POINTER_PATH = path.join(
  GLOBAL_CONFIG_DIR,
  'runtime-home.txt',
);

function expandHomePath(input: string): string {
  if (!input.startsWith('~')) return input;
  const suffix = input.slice(1);
  return path.join(os.homedir(), suffix);
}

export function resolveRuntimeHome(raw?: string): string {
  const source =
    raw?.trim() ||
    process.env.AGENT_ROOT?.trim() ||
    readPreferredRuntimeHome() ||
    DEFAULT_RUNTIME_HOME;
  const expanded = expandHomePath(source);
  return path.resolve(expanded);
}

export function ensureRuntimeLayout(runtimeHome: string): void {
  const dirs = [
    runtimeHome,
    path.join(runtimeHome, 'store'),
    path.join(runtimeHome, 'groups'),
    path.join(runtimeHome, 'data'),
    path.join(runtimeHome, 'logs'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function ensureRuntimeWritable(runtimeHome: string): void {
  ensureRuntimeLayout(runtimeHome);
  fs.accessSync(runtimeHome, fs.constants.W_OK);
}

export function envFilePath(runtimeHome: string): string {
  return path.join(runtimeHome, '.env');
}

export function onboardingStatePath(runtimeHome: string): string {
  return path.join(runtimeHome, '.onboarding-state.json');
}

export function runtimeLogPath(runtimeHome: string): string {
  return path.join(runtimeHome, 'logs', 'myclaw.log');
}

export function runtimeErrorLogPath(runtimeHome: string): string {
  return path.join(runtimeHome, 'logs', 'myclaw.error.log');
}

export function savePreferredRuntimeHome(runtimeHome: string): void {
  fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_HOME_POINTER_PATH, `${runtimeHome}\n`, 'utf-8');
}

export function readPreferredRuntimeHome(): string | null {
  try {
    const value = fs.readFileSync(RUNTIME_HOME_POINTER_PATH, 'utf-8').trim();
    return value ? path.resolve(expandHomePath(value)) : null;
  } catch {
    return null;
  }
}
