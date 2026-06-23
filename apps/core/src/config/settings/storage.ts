import fs from 'node:fs';
import path from 'node:path';

import { readRuntimeStorageSettingsSnapshot } from './runtime-settings.js';
import { settingsFilePath } from './runtime-home.js';
import { runtimeEnvValueDynamic } from '../env/index.js';
import {
  fleetRehearsalPlaintextPostgresHosts,
  validatePostgresConnectionUrl,
} from '../../adapters/storage/postgres/url.js';

export interface RuntimeStorageConfig {
  postgresUrlEnv: string;
  postgresUrl: string | null;
  postgresSchema: string;
  postgresPlaintextHostAllowlist?: readonly string[];
}

export function resolveRuntimeStorageConfig(
  gantryHome: string,
  _runtimeRoot: string,
): RuntimeStorageConfig {
  let settings;
  try {
    bootstrapStorageSettingsIfMissing(gantryHome);
    settings = readRuntimeStorageSettingsSnapshot(gantryHome);
  } catch (err) {
    const storageError = err instanceof Error ? err : new Error(String(err));
    throw new Error(
      `Invalid runtime storage settings: ${storageError.message}`,
      { cause: err },
    );
  }
  const postgresUrlEnv = settings.postgresUrlEnv || 'GANTRY_DATABASE_URL';
  const postgresUrl = runtimeEnvValueDynamic(postgresUrlEnv).trim() || null;
  const postgresPlaintextHostAllowlist = fleetRehearsalPlaintextPostgresHosts({
    GANTRY_FLEET_REHEARSAL_AUTO_SECRETS: runtimeEnvValueDynamic(
      'GANTRY_FLEET_REHEARSAL_AUTO_SECRETS',
    ),
  });
  if (postgresUrl) {
    try {
      validatePostgresConnectionUrl(postgresUrl, {
        allowLocalhost: true,
        plaintextHostAllowlist: postgresPlaintextHostAllowlist,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Invalid runtime storage settings: ${postgresUrlEnv} ${message}`,
        { cause: err },
      );
    }
  }
  return {
    postgresUrlEnv,
    postgresUrl,
    postgresSchema: settings.postgresSchema || 'gantry',
    postgresPlaintextHostAllowlist,
  };
}

function bootstrapStorageSettingsIfMissing(gantryHome: string): void {
  if (runtimeEnvValueDynamic('GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING') !== '1') {
    return;
  }
  const filePath = settingsFilePath(gantryHome);
  if (fs.existsSync(filePath)) return;

  const schema = resolveBootstrapSettingsSchema();
  const deploymentMode =
    runtimeEnvValueDynamic('GANTRY_BOOTSTRAP_DEPLOYMENT_MODE') ||
    runtimeEnvValueDynamic('GANTRY_DEPLOYMENT_MODE') ||
    'workstation';
  const sandboxProvider =
    runtimeEnvValueDynamic('GANTRY_BOOTSTRAP_SANDBOX_PROVIDER') ||
    'sandbox_runtime';
  const content = [
    'runtime:',
    `  deployment_mode: ${deploymentMode}`,
    '  sandbox:',
    `    provider: ${sandboxProvider}`,
    '',
    'storage:',
    '  postgres:',
    '    url_env: GANTRY_DATABASE_URL',
    `    schema: ${schema}`,
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function resolveBootstrapSettingsSchema(): string {
  const explicit = runtimeEnvValueDynamic(
    'GANTRY_SETTINGS_POSTGRES_SCHEMA',
  ).trim();
  if (explicit) return explicit;

  const url = runtimeEnvValueDynamic('GANTRY_DATABASE_URL').trim();
  if (url) {
    try {
      const schema = new URL(url).searchParams.get('schema')?.trim();
      if (schema) return schema;
    } catch {
      // Let the normal Postgres URL validation report malformed URLs.
    }
  }
  const bootstrapUrl = runtimeEnvValueDynamic(
    'GANTRY_BOOTSTRAP_DATABASE_URL',
  ).trim();
  if (bootstrapUrl) {
    try {
      const schema = new URL(bootstrapUrl).searchParams.get('schema')?.trim();
      if (schema) return schema;
    } catch {
      // Let the normal Postgres URL validation report malformed URLs.
    }
  }
  return runtimeEnvValueDynamic('GANTRY_DB_SCHEMA').trim() || 'gantry';
}
