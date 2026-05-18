import type { StorageService } from './storage-service.js';
import { evaluatePostgresStorageCapabilities } from './readiness.js';
import { readEnvFile } from '../../../config/env/file.js';
import { envFilePath } from '../../../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../../../config/settings/runtime-settings.js';
import { redactString } from '../../../infrastructure/logging/logger.js';

export interface RuntimeStorageReadiness {
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string[];
  nextAction?: string;
}

export interface RuntimeStorageReadinessOptions {
  migrate?: boolean;
}

function defaultPostgresNextAction(): string {
  return [
    'Use the provided docker-compose.yml, a locally installed Postgres, or a hosted Postgres endpoint with pgvector + pg_trgm + pg-boss initialized.',
    'Remote URLs must set sslmode=require or stronger.',
  ].join(' ');
}

export async function inspectRuntimeStorageReadiness(
  runtimeHome: string,
  options: RuntimeStorageReadinessOptions = {},
): Promise<RuntimeStorageReadiness> {
  let settings;
  try {
    settings = ensureRuntimeSettings(runtimeHome);
  } catch (err) {
    const message = redactString(
      err instanceof Error ? err.message : String(err),
    );
    return {
      status: 'fail',
      message: 'Runtime settings are invalid.',
      details: [message],
    };
  }

  const env = readEnvFile(envFilePath(runtimeHome));
  const postgresUrlEnv = settings.storage.postgres.urlEnv;
  const postgresUrl =
    env[postgresUrlEnv]?.trim() || process.env[postgresUrlEnv]?.trim() || '';
  if (!postgresUrl) {
    return {
      status: 'fail',
      message: `${postgresUrlEnv} is required for postgres storage.`,
      nextAction: defaultPostgresNextAction(),
    };
  }

  let service: StorageService;
  try {
    const { createStorageService } = await import('./storage-service.js');
    service = createStorageService({
      postgresUrl,
      postgresUrlEnv,
      postgresSchema: settings.storage.postgres.schema,
    });
  } catch (err) {
    const message = redactString(
      err instanceof Error ? err.message : String(err),
    );
    return {
      status: 'fail',
      message: 'Postgres storage configuration is invalid.',
      details: [message],
      nextAction: `Fix ${postgresUrlEnv} and retry. ${defaultPostgresNextAction()}`,
    };
  }

  try {
    if (options.migrate) {
      await service.migrate();
    }
    const capabilities = await service.healthCheck();
    const failure = evaluatePostgresStorageCapabilities(capabilities);
    if (!failure) {
      return {
        status: 'pass',
        message:
          'Postgres capabilities are ready (pgvector, search extension, pg-boss, durable runtime events, event outbox).',
      };
    }

    return {
      status: 'fail',
      message: failure.summary,
      details: failure.details,
      nextAction: defaultPostgresNextAction(),
    };
  } catch (err) {
    const message = redactString(
      err instanceof Error ? err.message : String(err),
    );
    return {
      status: 'fail',
      message: 'Cannot connect to postgres for storage readiness checks.',
      details: [message],
      nextAction: `Verify ${postgresUrlEnv} and database network access. For local personal setup, run \`gantry local status\` or \`gantry local setup\`.`,
    };
  } finally {
    await service.close();
  }
}
