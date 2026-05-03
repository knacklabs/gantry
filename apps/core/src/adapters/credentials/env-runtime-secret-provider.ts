import fs from 'fs';
import path from 'path';

import type { CredentialBrokerHealth } from '../../domain/models/credentials.js';
import type {
  RuntimeSecretProvider,
  RuntimeSecretRef,
} from '../../domain/ports/runtime-secret-provider.js';
import { getMyclawHome } from '../../shared/myclaw-home.js';

let cachedRuntimeEnv:
  | {
      path: string;
      mtimeMs: number;
      values: Map<string, string>;
    }
  | undefined;

function isForbiddenRuntimeSecretEnvName(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return (
    normalized.includes('API_KEY') ||
    normalized.includes('OAUTH_TOKEN') ||
    normalized.endsWith('_AUTH_TOKEN')
  );
}

function readRuntimeHomeEnvValues(): Map<string, string> {
  const envPath = path.join(getMyclawHome(), '.env');
  try {
    const stat = fs.statSync(envPath);
    if (
      cachedRuntimeEnv &&
      cachedRuntimeEnv.path === envPath &&
      cachedRuntimeEnv.mtimeMs === stat.mtimeMs
    ) {
      return cachedRuntimeEnv.values;
    }
    const raw = fs.readFileSync(envPath, 'utf8');
    const values = new Map<string, string>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      values.set(key, value.replace(/^['"]|['"]$/g, ''));
    }
    cachedRuntimeEnv = { path: envPath, mtimeMs: stat.mtimeMs, values };
    return values;
  } catch {
    cachedRuntimeEnv = undefined;
    return new Map();
  }
}

export class EnvRuntimeSecretProvider implements RuntimeSecretProvider {
  constructor(private readonly source: NodeJS.ProcessEnv = process.env) {}

  getSecret(ref: RuntimeSecretRef): string {
    const value = this.getOptionalSecret(ref);
    if (!value) {
      throw new Error(`${ref.env} is required.`);
    }
    return value;
  }

  getOptionalSecret(ref: RuntimeSecretRef): string | undefined {
    if (isForbiddenRuntimeSecretEnvName(ref.env)) return undefined;
    const direct = this.source[ref.env]?.trim();
    if (direct) return direct;
    if (this.source !== process.env) return undefined;
    const runtimeValue = readRuntimeHomeEnvValues().get(ref.env)?.trim();
    return runtimeValue || undefined;
  }

  async healthCheck(
    refs: RuntimeSecretRef[] = [],
  ): Promise<CredentialBrokerHealth> {
    const missing = refs
      .filter((ref) => !this.getOptionalSecret(ref))
      .map((ref) => ref.env);
    if (missing.length > 0) {
      return {
        status: 'fail',
        message: 'Runtime-owned secrets are missing.',
        details: missing,
      };
    }
    return {
      status: 'pass',
      message: 'Runtime-owned secrets are configured.',
    };
  }
}
