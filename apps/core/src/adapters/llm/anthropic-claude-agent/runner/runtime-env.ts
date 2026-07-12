import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyAgentEgressNoProxyEnv } from '../../../../shared/no-proxy.js';
import { applyNeutralCaTrustAliases } from '../../../../shared/neutral-ca-trust-env.js';
import { getPermissionTimeoutMs } from '../../../../shared/permission-timeout.js';
import { SDK_NATIVE_SKILL_DISABLE_ENV } from '../native-sdk-skills.js';
import { log } from './logging.js';

function requirePathEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const WORKSPACE_GROUP_DIR = requirePathEnv('GANTRY_WORKSPACE_GROUP_DIR');
export const WORKSPACE_EXTRA_DIR = requirePathEnv('GANTRY_WORKSPACE_EXTRA_DIR');
export const IPC_BASE_DIR = requirePathEnv('GANTRY_IPC_DIR');
export const IPC_INPUT_DIR = requirePathEnv('GANTRY_IPC_INPUT_DIR');
export const IPC_INTERACTION_BOUNDARY_DIR = path.join(
  IPC_BASE_DIR,
  'interaction-boundaries',
);
export const IPC_AUTH_TOKEN = process.env.GANTRY_IPC_AUTH_TOKEN || '';
export const APP_ID = process.env.GANTRY_APP_ID?.trim() || '';
export const AGENT_ID = process.env.GANTRY_AGENT_ID?.trim() || '';
export const CHAT_JID = process.env.GANTRY_CHAT_JID?.trim() || '';
export const PROVIDER_ACCOUNT_ID =
  process.env.GANTRY_PROVIDER_ACCOUNT_ID?.trim() || '';
export const JOB_ID = process.env.GANTRY_JOB_ID?.trim() || '';
export const JOB_NAME = process.env.GANTRY_JOB_NAME?.trim() || '';
export const JOB_RUN_ID = process.env.GANTRY_JOB_RUN_ID?.trim() || '';
export const JOB_RUN_LEASE_TOKEN =
  process.env.GANTRY_JOB_RUN_LEASE_TOKEN?.trim() || '';
export const JOB_RUN_LEASE_FENCING_VERSION =
  process.env.GANTRY_JOB_RUN_LEASE_FENCING_VERSION?.trim() || '';
export const IPC_RESPONSE_VERIFY_KEY =
  process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY || '';
export const IPC_RESPONSE_KEY_ID = process.env.GANTRY_IPC_RESPONSE_KEY_ID || '';
export const PERMISSION_MODE =
  process.env.GANTRY_PERMISSION_MODE?.trim() === 'auto' ? 'auto' : 'ask';
export const TURN_INTENT_SUMMARY =
  process.env.GANTRY_TURN_INTENT_SUMMARY?.trim() || '';
export const SENDER_ID = process.env.GANTRY_MEMORY_USER_ID?.trim() || '';
export const SENDER_IS_CONTROL_APPROVER =
  process.env.GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER === '1';
export const PERMISSION_REQUEST_TIMEOUT_MS = getPermissionTimeoutMs(
  JOB_ID ? 'autonomous' : 'interactive',
);
export const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
export const RUNTIME_SIGNAL_FALLBACK_POLL_MS = 500;

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

const NON_MODEL_PROXY_ENV_KEYS = [
  'ALL_PROXY',
  'all_proxy',
  'GIT_HTTP_PROXY_AUTHMETHOD',
  'GIT_TERMINAL_PROMPT',
] as const;
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;
const SANDBOX_RUNTIME_TOOL_PROXY_ENV_KEYS = [
  ...PROXY_ENV_KEYS,
  'FTP_PROXY',
  'ftp_proxy',
  'RSYNC_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'GRPC_PROXY',
  'grpc_proxy',
  'GIT_SSH_COMMAND',
] as const;
const SANDBOX_RUNTIME_GO_DNS = 'netdns=go';
const SANDBOX_RUNTIME_SDK_DIRECT_EGRESS_GUARDS = {
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_BYOC_ENABLE_DATADOG: '0',
  CLAUDE_CODE_REMOTE_SEND_KEEPALIVES: '0',
} as const;
const CLAUDE_CODE_RUNTIME_FEATURE_GUARDS = {
  // Gantry owns orchestration and tool routing; Claude Code Workflows injects
  // keyword-triggered meta notes that leak into live channel replies.
  CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
} as const;
const SANDBOX_RUNTIME_SDK_DIRECT_EGRESS_ENV_DENYLIST = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'DATADOG_LOGS_ENDPOINT',
  'DATADOG_CLIENT_TOKEN',
] as const;

const MODEL_CREDENTIAL_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'NODE_EXTRA_CA_CERTS',
]);
function readModelCredentialEnv(
  source: Record<string, unknown> | undefined,
): Record<string, string | undefined> {
  if (!source) return {};
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!MODEL_CREDENTIAL_ENV_KEYS.has(key)) {
      throw new Error(`modelCredentialEnv.${key} is not supported.`);
    }
    if (typeof value === 'string') {
      env[key] = value;
      continue;
    }
    if (value !== undefined && value !== null) {
      throw new Error(`modelCredentialEnv.${key} must be a string.`);
    }
  }
  return env;
}

function stripNonModelProxyEnv(
  target: Record<string, string | undefined>,
): void {
  for (const key of NON_MODEL_PROXY_ENV_KEYS) {
    target[key] = undefined;
  }
}

function applySandboxRuntimeProxyEnv(
  target: Record<string, string | undefined>,
): void {
  if (process.env.GANTRY_SANDBOX_RUNTIME_PROXY !== '1') return;
  target.CLAUDE_CODE_SANDBOXED = '1';
  for (const key of SANDBOX_RUNTIME_TOOL_PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) target[key] = value;
  }
  target.http_proxy = target.http_proxy ?? target.HTTP_PROXY;
  target.https_proxy = target.https_proxy ?? target.HTTPS_PROXY;
  if (
    target.HTTP_PROXY ||
    target.http_proxy ||
    target.HTTPS_PROXY ||
    target.https_proxy
  ) {
    target.NODE_USE_ENV_PROXY = '1';
  }
  target.CLAUDE_CODE_PROXY_RESOLVES_HOSTS = '1';
  target.GODEBUG = target.GODEBUG?.trim() || SANDBOX_RUNTIME_GO_DNS;
  target.NO_PROXY = '';
  target.no_proxy = '';
}

function applySandboxRuntimeSdkDirectEgressGuards(
  target: Record<string, string | undefined>,
): void {
  if (process.env.GANTRY_SANDBOX_RUNTIME_PROXY !== '1') return;
  Object.assign(target, SANDBOX_RUNTIME_SDK_DIRECT_EGRESS_GUARDS);
  const modelBaseUrl = target.ANTHROPIC_BASE_URL?.trim();
  if (modelBaseUrl) {
    target.CLAUDE_CODE_API_BASE_URL = modelBaseUrl;
  }
  for (const key of SANDBOX_RUNTIME_SDK_DIRECT_EGRESS_ENV_DENYLIST) {
    delete target[key];
  }
}

function hasProxyEnv(target: Record<string, string | undefined>): boolean {
  return PROXY_ENV_KEYS.some((key) => !!target[key]?.trim());
}

export function buildEffectiveToolNetworkEnv(
  toolNetworkEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string | undefined> = {
    ...(toolNetworkEnv ?? {}),
  };
  applySandboxRuntimeProxyEnv(env);
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        (entry[1].length > 0 ||
          entry[0] === 'NO_PROXY' ||
          entry[0] === 'no_proxy'),
    ),
  );
}

export function buildSdkEnv(
  modelCredentialEnv?: Record<string, string>,
): Record<string, string | undefined> {
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
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    ...CLAUDE_CODE_RUNTIME_FEATURE_GUARDS,
    ...SDK_NATIVE_SKILL_DISABLE_ENV,
  };
  Object.assign(sdkEnv, readModelCredentialEnv(modelCredentialEnv));
  applyNeutralCaTrustAliases(sdkEnv);
  copyPlaceholderEnv(sdkEnv, ['ANTHROPIC_API_KEY']);
  stripNonModelProxyEnv(sdkEnv);
  applySandboxRuntimeProxyEnv(sdkEnv);
  applySandboxRuntimeSdkDirectEgressGuards(sdkEnv);
  if (hasProxyEnv(sdkEnv)) {
    sdkEnv.NO_PROXY = '';
    sdkEnv.no_proxy = '';
  } else {
    applyAgentEgressNoProxyEnv(sdkEnv, { externalBypass: false });
  }
  delete sdkEnv.GANTRY_IPC_AUTH_TOKEN;
  delete sdkEnv.GANTRY_IPC_RESPONSE_VERIFY_KEY;
  delete sdkEnv.GANTRY_IPC_RESPONSE_KEY_ID;
  delete sdkEnv.GANTRY_MCP_CONFIG_FILE;
  delete sdkEnv.GANTRY_MCP_SERVERS_JSON;
  delete sdkEnv.GANTRY_MCP_ALLOWED_TOOLS_JSON;
  return sdkEnv;
}

export function resolveClaudeCodeExecutableFromPath(
  envPath: string | undefined = process.env.PATH,
): string | undefined {
  if (!envPath) return undefined;
  for (const entry of envPath.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, 'claude');
    try {
      if (!fs.existsSync(candidate)) continue;
      return fs.realpathSync(candidate);
    } catch {
      return candidate;
    }
  }
  return undefined;
}

export function allowedOuterSandboxClaudeExecutable(
  executable: string | undefined,
): string | undefined {
  if (!executable) return undefined;
  const resolved = path.resolve(executable);
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const allowedRoots = [
    '/bin',
    '/usr/bin',
    '/usr/local',
    '/opt/homebrew',
    '/System',
    '/Library/Developer/CommandLineTools',
    ...(home
      ? [
          path.join(home, '.local', 'bin'),
          path.join(home, '.local', 'share', 'claude', 'versions'),
        ]
      : []),
  ];
  return allowedRoots.some((root) => pathContainsOrEquals(root, resolved))
    ? resolved
    : undefined;
}

function pathContainsOrEquals(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function resolveMcpServerPath(importMetaUrl: string): string {
  const configuredPath = process.env.GANTRY_MCP_SERVER_PATH?.trim();
  if (configuredPath) {
    return configuredPath;
  }
  const dirname = path.dirname(fileURLToPath(importMetaUrl));
  return path.join(
    dirname,
    '..',
    '..',
    '..',
    '..',
    'runner',
    'mcp',
    'stdio.js',
  );
}

export function resolveWorkspaceIpcDir(workspaceFolder: string): string {
  if (path.basename(IPC_BASE_DIR) === workspaceFolder) {
    return IPC_BASE_DIR;
  }
  return path.join(IPC_BASE_DIR, workspaceFolder);
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
