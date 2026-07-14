import type { StorageService } from './storage-service.js';
import { evaluatePostgresStorageCapabilities } from './readiness.js';
import { fleetRehearsalPlaintextPostgresHosts } from './url.js';
import { createRepositoryRuntimeSecretProvider } from '../../credentials/repository-runtime-secret-provider.js';
import { getProvider } from '../../../channels/provider-registry.js';
import { readEnvFile } from '../../../config/env/file.js';
import { envFilePath } from '../../../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../../../config/settings/runtime-settings.js';
import type { AppId } from '../../../domain/app/app.js';
import {
  getOptionalRuntimeSecret,
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../../../domain/ports/runtime-secret-provider.js';
import { runtimeSecretKeyForEnv } from '../../../domain/provider/provider-runtime-secret-keys.js';
import { redactString } from '../../../infrastructure/logging/logger.js';

export interface RuntimeStorageReadiness {
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string[];
  nextAction?: string;
}

interface RuntimeSecretReadinessSettings {
  storage: {
    postgres: {
      urlEnv: string;
      schema: string;
    };
  };
  providers: Record<string, { enabled: boolean } | undefined>;
  providerAccounts: Record<
    string,
    | {
        provider: string;
        status?: string;
        runtimeSecretRefs: Record<string, string | undefined>;
      }
    | undefined
  >;
}

function defaultPostgresNextAction(): string {
  return [
    'Use the provided docker-compose.yml, a locally installed Postgres, or a hosted Postgres endpoint with pgvector + pg_trgm + pg-boss initialized.',
    'Remote URLs must set sslmode=require or stronger.',
  ].join(' ');
}

export async function inspectRuntimeStorageReadiness(
  runtimeHome: string,
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
      postgresPlaintextHostAllowlist: fleetRehearsalPlaintextPostgresHosts({
        ...env,
        ...process.env,
      }),
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
    await service.assertMigrationsCurrent();
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

export async function inspectRuntimeSecretReadiness(
  runtimeHome: string,
  settings: RuntimeSecretReadinessSettings,
): Promise<RuntimeStorageReadiness> {
  const refsToResolve: {
    providerId: string;
    providerAccountId: string;
    refKey: string;
    ref: string;
  }[] = [];
  for (const [providerAccountId, account] of Object.entries(
    settings.providerAccounts,
  )) {
    if (!account) continue;
    if (account.status === 'disabled') continue;
    const providerId = account.provider;
    if (!settings.providers[providerId]?.enabled) continue;
    const provider = getProvider(providerId);
    const refs = account.runtimeSecretRefs;
    for (const envKey of provider?.setup.envKeys ?? []) {
      const refKey = runtimeSecretKeyForEnv(providerId, envKey);
      const rawRef = refs?.[refKey]?.trim();
      if (!rawRef) continue;
      const normalized = normalizeRuntimeSecretRefString(rawRef);
      const parsed = parseRuntimeSecretRefString(normalized);
      if (parsed.source === 'env') continue;
      refsToResolve.push({
        providerId,
        providerAccountId,
        refKey,
        ref: normalized,
      });
    }
  }
  if (refsToResolve.length === 0) {
    return {
      status: 'pass',
      message: 'No storage-backed runtime secret refs require validation.',
    };
  }

  const env = readEnvFile(envFilePath(runtimeHome));
  const postgresUrlEnv = settings.storage.postgres.urlEnv;
  const postgresUrl =
    env[postgresUrlEnv]?.trim() || process.env[postgresUrlEnv]?.trim() || '';
  const { createStorageRuntime } = await import('./factory.js');
  const storage = createStorageRuntime({
    postgresUrl,
    postgresUrlEnv,
    postgresSchema: settings.storage.postgres.schema,
    postgresPlaintextHostAllowlist: fleetRehearsalPlaintextPostgresHosts({
      ...env,
      ...process.env,
    }),
  });
  try {
    await storage.service.assertMigrationsCurrent();
    const secrets = createRepositoryRuntimeSecretProvider({
      appId: 'default' as AppId,
      repository: storage.repositories.capabilitySecrets,
    });
    const missing: string[] = [];
    for (const ref of refsToResolve) {
      const value = await getOptionalRuntimeSecret(secrets, { ref: ref.ref });
      if (!value?.trim()) {
        missing.push(
          `provider_accounts.${ref.providerAccountId}.provider ${ref.providerId} runtime_secret_refs.${ref.refKey} runtime secret ref ${ref.ref} did not resolve.`,
        );
      }
    }
    if (missing.length === 0) {
      return {
        status: 'pass',
        message: 'Runtime secret refs are ready.',
      };
    }
    return {
      status: 'fail',
      message: 'Runtime secret preflight failed.',
      details: missing,
    };
  } finally {
    await storage.service.close();
  }
}
