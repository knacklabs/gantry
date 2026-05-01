import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyLoopbackNoProxyEnv } from '../../shared/no-proxy.js';
import { log } from './logging.js';

function requirePathEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const WORKSPACE_GROUP_DIR = requirePathEnv('MYCLAW_WORKSPACE_GROUP_DIR');
export const WORKSPACE_EXTRA_DIR = requirePathEnv('MYCLAW_WORKSPACE_EXTRA_DIR');
export const IPC_BASE_DIR = requirePathEnv('MYCLAW_IPC_DIR');
export const IPC_INPUT_DIR = requirePathEnv('MYCLAW_IPC_INPUT_DIR');
export const IPC_INTERACTION_BOUNDARY_DIR = path.join(
  IPC_BASE_DIR,
  'interaction-boundaries',
);
export const IPC_AUTH_TOKEN = process.env.MYCLAW_IPC_AUTH_TOKEN || '';
export const IPC_RESPONSE_VERIFY_KEY =
  process.env.MYCLAW_IPC_RESPONSE_VERIFY_KEY || '';
export const PERMISSION_REQUEST_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(process.env.MYCLAW_PERMISSION_TIMEOUT_MS || '300000', 10) || 300_000,
);
export const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
export const IPC_POLL_MS = 500;

function copyEnv(
  target: Record<string, string | undefined>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      target[key] = value;
    }
  }
}

function copyPlaceholderEnv(
  target: Record<string, string | undefined>,
  keys: string[],
): void {
  for (const key of keys) {
    if (process.env[key] === 'placeholder') {
      target[key] = 'placeholder';
    }
  }
}

const MODEL_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NODE_USE_ENV_PROXY',
] as const;

const NON_MODEL_PROXY_ENV_KEYS = [
  'ALL_PROXY',
  'all_proxy',
  'GIT_HTTP_PROXY_AUTHMETHOD',
  'GIT_TERMINAL_PROMPT',
] as const;

function stripNonModelProxyEnv(
  target: Record<string, string | undefined>,
): void {
  for (const key of NON_MODEL_PROXY_ENV_KEYS) {
    target[key] = undefined;
  }
}

export function buildSdkEnv(): Record<string, string | undefined> {
  const sdkEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE,
    TERM: process.env.TERM,
    TZ: process.env.TZ,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  };
  if (process.env.ANTHROPIC_API_KEY === '') {
    sdkEnv.ANTHROPIC_API_KEY = '';
  }
  copyPlaceholderEnv(sdkEnv, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  copyEnv(sdkEnv, [
    'NO_PROXY',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    ...MODEL_PROXY_ENV_KEYS,
  ]);
  stripNonModelProxyEnv(sdkEnv);
  applyLoopbackNoProxyEnv(sdkEnv);
  delete sdkEnv.MYCLAW_IPC_AUTH_TOKEN;
  delete sdkEnv.MYCLAW_IPC_RESPONSE_VERIFY_KEY;
  delete sdkEnv.MYCLAW_MCP_CONFIG_FILE;
  delete sdkEnv.MYCLAW_MCP_SERVERS_JSON;
  delete sdkEnv.MYCLAW_MCP_ALLOWED_TOOLS_JSON;
  return sdkEnv;
}

export function resolveMcpServerPath(importMetaUrl: string): string {
  const dirname = path.dirname(fileURLToPath(importMetaUrl));
  return path.join(dirname, '..', 'mcp', 'stdio.js');
}

export function resolveGroupIpcDir(groupFolder: string): string {
  if (path.basename(IPC_BASE_DIR) === groupFolder) {
    return IPC_BASE_DIR;
  }
  return path.join(IPC_BASE_DIR, groupFolder);
}

export function discoverAdditionalDirectories(): string[] {
  const extraDirs: string[] = [];
  const extraBase = WORKSPACE_EXTRA_DIR;
  if (fs.existsSync(extraBase)) {
    const realExtraBase = fs.realpathSync(extraBase);
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      const stat = fs.lstatSync(fullPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        continue;
      }
      const realFullPath = fs.realpathSync(fullPath);
      if (
        realFullPath === realExtraBase ||
        realFullPath.startsWith(`${realExtraBase}${path.sep}`)
      ) {
        extraDirs.push(realFullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }
  return extraDirs;
}
