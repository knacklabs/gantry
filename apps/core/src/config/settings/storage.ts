import { readRuntimeStorageSettingsSnapshot } from './runtime-settings.js';
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
