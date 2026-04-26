import { readEnvFile } from './env/file.js';
import { ensureRuntimeLayout, envFilePath } from './settings/runtime-home.js';
import {
  ensureRuntimeSettings,
  validateRuntimeSettings,
} from './settings/runtime-settings.js';
import {
  inspectOnecliPersistenceReadiness,
  ONECLI_SECRET_ENCRYPTION_KEY_ENV,
} from '../adapters/credentials/onecli/local/persistence.js';
import { EnvRuntimeSecretProvider } from '../adapters/credentials/env-runtime-secret-provider.js';
import { inspectRuntimeStorageReadiness } from '../infrastructure/postgres/storage-readiness.js';
import { validateExternalBrokerUrl } from './credentials/broker-url-policy.js';

export interface RuntimePreflightFailure {
  summary: string;
  details: string[];
}

export interface RuntimePreflightResult {
  ok: boolean;
  failure?: RuntimePreflightFailure;
}

export function validateRuntimePreflight(
  runtimeHome: string,
): RuntimePreflightResult {
  ensureRuntimeLayout(runtimeHome);
  const settingsValidation = validateRuntimeSettings(runtimeHome);
  if (!settingsValidation.ok && settingsValidation.failure) {
    return {
      ok: false,
      failure: settingsValidation.failure,
    };
  }

  return { ok: true };
}

export async function validateRuntimePreflightWithStorage(
  runtimeHome: string,
): Promise<RuntimePreflightResult> {
  const base = validateRuntimePreflight(runtimeHome);
  if (!base.ok) {
    return base;
  }

  const storageReadiness = await inspectRuntimeStorageReadiness(runtimeHome);
  if (storageReadiness.status === 'fail') {
    return {
      ok: false,
      failure: {
        summary: storageReadiness.message,
        details: [
          ...(storageReadiness.details || []),
          ...(storageReadiness.nextAction
            ? [`Next action: ${storageReadiness.nextAction}`]
            : []),
        ],
      },
    };
  }

  const settings = ensureRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const runtimeSecretsSource = {
    ...process.env,
    ...env,
  };
  const runtimeSecrets = new EnvRuntimeSecretProvider(runtimeSecretsSource);
  const credentialMode = settings.credentialBroker.mode;
  if (credentialMode === 'external') {
    try {
      const validation = validateExternalBrokerUrl(
        settings.credentialBroker.external.baseUrl,
        'credential_broker.external.base_url',
      );
      if (!validation.ok || !validation.normalizedUrl) {
        throw new Error(
          validation.error || 'credential_broker.external.base_url is invalid.',
        );
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        failure: {
          summary:
            err instanceof Error
              ? err.message
              : 'External credential broker is not configured.',
          details: [
            'Next action: Set credential_broker.external.base_url in settings.yaml to a broker-safe external credential endpoint.',
          ],
        },
      };
    }
  }
  if (credentialMode !== 'onecli') {
    return { ok: true };
  }
  const onecliPostgres = settings.credentialBroker.onecli.postgres;
  const postgres = settings.storage.postgres;
  const onecliReadiness = await inspectOnecliPersistenceReadiness({
    postgresUrl:
      runtimeSecrets.getOptionalSecret({ env: onecliPostgres.urlEnv }) || '',
    schema: onecliPostgres.schema,
    secretEncryptionKey:
      runtimeSecrets.getOptionalSecret({
        env: ONECLI_SECRET_ENCRYPTION_KEY_ENV,
      }) || '',
    myclawPostgresUrl:
      runtimeSecrets.getOptionalSecret({ env: postgres.urlEnv }) || '',
    myclawSchema: postgres.schema,
  });
  if (onecliReadiness.status !== 'fail') {
    return { ok: true };
  }

  return {
    ok: false,
    failure: {
      summary: onecliReadiness.message,
      details: [
        ...(onecliReadiness.details || []),
        ...(onecliReadiness.nextAction
          ? [`Next action: ${onecliReadiness.nextAction}`]
          : []),
      ],
    },
  };
}

export function formatRuntimePreflightFailure(
  failure: RuntimePreflightFailure,
): string {
  return [failure.summary, ...failure.details.map((line) => `- ${line}`)].join(
    '\n',
  );
}
