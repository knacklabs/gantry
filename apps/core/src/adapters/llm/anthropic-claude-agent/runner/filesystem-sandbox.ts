import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';

import { log } from './logging.js';

const PROTECTED_FILESYSTEM_PATHS_ENV = 'GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON';
const PROTECTED_FILESYSTEM_DENY_READ_PATHS_ENV =
  'GANTRY_PROTECTED_FILESYSTEM_DENY_READ_PATHS_JSON';
const PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_ENV =
  'GANTRY_PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_JSON';
const LOCAL_CLI_CREDENTIAL_DIRS_ENV = 'GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON';

interface BuildSdkFilesystemSandboxOptions {
  platform?: NodeJS.Platform;
  denyReadPaths?: readonly string[];
  denyWritePaths?: readonly string[];
  httpProxyPort?: number;
}

export interface ProtectedFilesystemSandboxPaths {
  denyRead: string[];
  denyWrite: string[];
}

export function readProtectedFilesystemPaths(): string[] {
  return readPathListEnv(PROTECTED_FILESYSTEM_PATHS_ENV);
}

export function readProtectedFilesystemSandboxPaths(): ProtectedFilesystemSandboxPaths {
  const fallback =
    readOptionalPathListEnv(PROTECTED_FILESYSTEM_PATHS_ENV) ?? [];
  return {
    denyRead:
      readOptionalPathListEnv(PROTECTED_FILESYSTEM_DENY_READ_PATHS_ENV) ??
      fallback,
    denyWrite:
      readOptionalPathListEnv(PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_ENV) ??
      fallback,
  };
}

export function readLocalCliCredentialDirectories(): string[] {
  return readPathListEnv(LOCAL_CLI_CREDENTIAL_DIRS_ENV);
}

function readOptionalPathListEnv(name: string): string[] | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  return readPathListEnv(name);
}

function readPathListEnv(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name} must be valid JSON.`, {
      cause: err,
    });
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array.`);
  return normalizeFilesystemSandboxPaths(parsed);
}

export function buildSdkFilesystemSandbox(
  paths: readonly string[],
  options: BuildSdkFilesystemSandboxOptions = {},
): SandboxSettings {
  const platform = options.platform ?? process.platform;
  const denyReadPaths = options.denyReadPaths ?? paths;
  const denyWritePaths = options.denyWritePaths ?? paths;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: {
      allowLocalBinding: true,
      ...(options.httpProxyPort
        ? { httpProxyPort: options.httpProxyPort }
        : {}),
    },
    ...(platform === 'darwin' ? { enableWeakerNetworkIsolation: true } : {}),
    filesystem: {
      denyRead: normalizeFilesystemSandboxPaths(denyReadPaths),
      denyWrite: normalizeFilesystemSandboxPaths(denyWritePaths),
    },
  };
}

export function requireSdkSandboxEgressProxyPort(
  proxyUrl: string | undefined,
): number {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl?.trim() ?? '');
  } catch {
    throw new Error(
      'GANTRY_EGRESS_PROXY_URL must identify the run-scoped loopback HTTP egress gateway.',
    );
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65_535
  ) {
    throw new Error(
      'GANTRY_EGRESS_PROXY_URL must identify the run-scoped loopback HTTP egress gateway.',
    );
  }
  return port;
}

export function normalizeFilesystemSandboxPaths(
  values: readonly unknown[],
): string[] {
  return [...new Set(values.flatMap(resolvePathForSandbox))].sort();
}

function resolvePathForSandbox(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const trimmed = value.trim();
  const expanded = expandCredentialPathTemplate(trimmed);
  if (!expanded) return [];
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const absolute =
    expanded === '~'
      ? (home ?? expanded)
      : (expanded.startsWith('~/') || expanded.startsWith('~\\')) && home
        ? path.join(home, expanded.slice(2))
        : path.resolve(expanded);
  if (process.env.GANTRY_SANDBOX_RUNTIME_PROXY === '1') {
    return [absolute];
  }
  try {
    if (fs.existsSync(absolute)) return [fs.realpathSync.native(absolute)];
    const parent = path.dirname(absolute);
    if (fs.existsSync(parent))
      return [
        path.join(fs.realpathSync.native(parent), path.basename(absolute)),
      ];
  } catch (err) {
    log(
      `Failed to resolve protected filesystem path "${absolute}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return [absolute];
}

function expandCredentialPathTemplate(value: string): string | null {
  let missing = false;
  const expanded = value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
      const envValue = process.env[key];
      if (!envValue) missing = true;
      return envValue ?? '';
    })
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) => {
      const envValue = process.env[key];
      if (!envValue) missing = true;
      return envValue ?? '';
    })
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, key: string) => {
      const envValue = process.env[key];
      if (!envValue) missing = true;
      return envValue ?? '';
    });
  return missing ? null : expanded;
}
