import fs from 'node:fs';
import path from 'node:path';

import { log } from './logging.js';

const LOCAL_CLI_CREDENTIAL_DIRS_ENV = 'GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON';

export function readLocalCliCredentialDirectories(): string[] {
  return readPathListEnv(LOCAL_CLI_CREDENTIAL_DIRS_ENV);
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
