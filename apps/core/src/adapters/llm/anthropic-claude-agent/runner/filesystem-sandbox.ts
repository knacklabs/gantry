import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';

import { log } from './logging.js';

const PROTECTED_FILESYSTEM_PATHS_ENV = 'GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON';

interface BuildSdkFilesystemSandboxOptions {
  platform?: NodeJS.Platform;
}

export function readProtectedFilesystemPaths(): string[] {
  const raw = process.env[PROTECTED_FILESYSTEM_PATHS_ENV]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${PROTECTED_FILESYSTEM_PATHS_ENV} must be valid JSON.`, {
      cause: err,
    });
  }
  if (!Array.isArray(parsed))
    throw new Error(`${PROTECTED_FILESYSTEM_PATHS_ENV} must be a JSON array.`);
  return normalizeProtectedPaths(parsed);
}

export function buildSdkFilesystemSandbox(
  paths: readonly string[],
  options: BuildSdkFilesystemSandboxOptions = {},
): SandboxSettings {
  const platform = options.platform ?? process.platform;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: { allowLocalBinding: true },
    ...(platform === 'darwin' ? { enableWeakerNetworkIsolation: true } : {}),
    filesystem: { denyWrite: normalizeProtectedPaths(paths) },
  };
}

function normalizeProtectedPaths(values: readonly unknown[]): string[] {
  return [...new Set(values.flatMap(resolvePathForSandbox))].sort();
}

function resolvePathForSandbox(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const absolute = path.resolve(value.trim());
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
