import {
  getProvider,
  normalizeProviderId,
} from '../../channels/provider-registry.js';
import {
  ONECLI_SECRET_ENCRYPTION_KEY_ENV,
  validateSharedPostgresDatabase,
  validateOnecliDatabaseUrl,
  validateOnecliSecretEncryptionKey,
} from '../../adapters/credentials/onecli/local/persistence.js';
import { validatePostgresConnectionUrl } from '../../adapters/storage/postgres/url.js';
import { readEnvFile } from '../env/file.js';
import { validateOnecliUrl } from '../../adapters/credentials/onecli/policy.js';
import { validateExternalBrokerUrl } from '../credentials/broker-url-policy.js';
import { validateRuntimeEnvPolicy } from '../source-classification.js';
import {
  resolveModelSelectionForWorkload,
  type ModelWorkload,
} from '../../shared/model-catalog.js';
import { validateReadableAgentToolRule } from '../../shared/agent-tool-references.js';
import { envFilePath, settingsFilePath } from './runtime-home.js';
import type {
  RuntimeSettings,
  RuntimeSettingsValidationResult,
} from './runtime-settings-types.js';

export function validateLoadedRuntimeSettings(
  runtimeHome: string,
  settings: RuntimeSettings,
): RuntimeSettingsValidationResult {
  const details: string[] = [];

  const env = readEnvFile(envFilePath(runtimeHome));
  const envPolicy = validateRuntimeEnvPolicy(env);
  for (const violation of envPolicy.violations) {
    details.push(violation.message);
  }
  const processEnvPolicy = validateRuntimeEnvPolicy(
    process.env,
    'the process environment',
  );
  for (const violation of processEnvPolicy.violations) {
    details.push(violation.message);
  }
  const credentialMode = settings.credentialBroker.mode;
  for (const [field, value, workload] of [
    ['agent.default_model', settings.agent.defaultModel, 'chat'],
    [
      'agent.one_time_job_default_model',
      settings.agent.oneTimeJobDefaultModel,
      'one_time_job',
    ],
    [
      'agent.recurring_job_default_model',
      settings.agent.recurringJobDefaultModel,
      'recurring_job',
    ],
  ] as const satisfies readonly (readonly [string, string, ModelWorkload])[]) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const resolved = resolveModelSelectionForWorkload(trimmed, workload);
    if (!resolved.ok) {
      details.push(`${field} is invalid: ${resolved.message}`);
    }
  }
  for (const [field, value, workload] of [
    [
      'memory.llm.models.extractor',
      settings.memory.llm.models.extractor,
      'memory_extractor',
    ],
    [
      'memory.llm.models.dreaming',
      settings.memory.llm.models.dreaming,
      'memory_dreaming',
    ],
    [
      'memory.llm.models.consolidation',
      settings.memory.llm.models.consolidation,
      'memory_consolidation',
    ],
  ] as const satisfies readonly (readonly [string, string, ModelWorkload])[]) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const resolved = resolveModelSelectionForWorkload(trimmed, workload);
    if (!resolved.ok) {
      details.push(`${field} is invalid: ${resolved.message}`);
    }
  }
  const postgresUrlEnv = settings.storage.postgres.urlEnv;
  const postgresUrl =
    process.env[postgresUrlEnv]?.trim() || env[postgresUrlEnv]?.trim() || '';
  if (!postgresUrl) {
    details.push(`${postgresUrlEnv} is required for runtime storage.`);
  } else {
    try {
      validatePostgresConnectionUrl(postgresUrl, {
        allowLocalhost: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      details.push(`${postgresUrlEnv} is invalid: ${message}`);
    }
  }

  const onecliDatabaseUrlEnv = settings.credentialBroker.onecli.postgres.urlEnv;
  const onecliDatabaseUrl =
    process.env[onecliDatabaseUrlEnv]?.trim() ||
    env[onecliDatabaseUrlEnv]?.trim() ||
    '';
  if (!onecliDatabaseUrl && credentialMode === 'onecli') {
    details.push(
      `${onecliDatabaseUrlEnv} is required for OneCLI broker persistence.`,
    );
  } else if (onecliDatabaseUrl && credentialMode === 'onecli') {
    try {
      validatePostgresConnectionUrl(onecliDatabaseUrl, {
        allowLocalhost: true,
      });
      const onecliValidation = validateOnecliDatabaseUrl({
        postgresUrl: onecliDatabaseUrl,
        schema: settings.credentialBroker.onecli.postgres.schema,
      });
      if (!onecliValidation.ok) {
        details.push(onecliValidation.message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      details.push(`${onecliDatabaseUrlEnv} is invalid: ${message}`);
    }
  }
  if (postgresUrl && onecliDatabaseUrl && credentialMode === 'onecli') {
    try {
      const sharedDatabase = validateSharedPostgresDatabase({
        gantryPostgresUrl: postgresUrl,
        onecliPostgresUrl: onecliDatabaseUrl,
      });
      if (!sharedDatabase.ok) {
        details.push(sharedDatabase.message);
      }
      const gantryUser = new URL(postgresUrl).username;
      const onecliUser = new URL(onecliDatabaseUrl).username;
      if (gantryUser && onecliUser && gantryUser === onecliUser) {
        details.push(
          'GANTRY_DATABASE_URL and ONECLI_DATABASE_URL must use different Postgres roles.',
        );
      }
    } catch {
      // URL validity is reported by the concrete validators above.
    }
  }
  const onecliSecret =
    process.env[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim() ||
    env[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim();
  if (credentialMode === 'onecli') {
    const secretValidation = validateOnecliSecretEncryptionKey(onecliSecret);
    if (!secretValidation.ok) {
      details.push(secretValidation.message);
    }
  }

  const onecliUrl = settings.credentialBroker.onecli.url.trim();
  if (!onecliUrl && credentialMode === 'onecli') {
    details.push(
      'credential_broker.onecli.url is required for OneCLI broker access.',
    );
  } else if (onecliUrl && credentialMode === 'onecli') {
    const onecliUrlValidation = validateOnecliUrl(
      onecliUrl,
      'credential_broker.onecli.url',
    );
    if (!onecliUrlValidation.ok) {
      details.push(
        onecliUrlValidation.error || 'credential_broker.onecli.url is invalid.',
      );
    }
  }
  if (credentialMode === 'external') {
    const externalUrl = settings.credentialBroker.external.baseUrl.trim();
    if (!externalUrl) {
      details.push(
        'credential_broker.external.base_url is required for external credential broker access.',
      );
    } else {
      const externalUrlValidation = validateExternalBrokerUrl(
        externalUrl,
        'credential_broker.external.base_url',
      );
      if (!externalUrlValidation.ok) {
        details.push(
          externalUrlValidation.error ||
            'credential_broker.external.base_url is invalid.',
        );
      }
    }
  }

  const enabledProviderIds = Object.entries(settings.providers)
    .filter(([, provider]) => provider.enabled)
    .map(([providerId]) => providerId);

  for (const providerId of enabledProviderIds) {
    const provider = getProvider(providerId);
    if (!provider) {
      details.push(
        `providers.${providerId}.enabled is true but no provider is registered for '${providerId}'.`,
      );
      continue;
    }

    for (const envKey of provider.setup.envKeys) {
      if (!env[envKey]?.trim() && !process.env[envKey]?.trim()) {
        details.push(
          `${envKey} is required when provider '${provider.id}' is enabled.`,
        );
      }
    }
  }

  for (const [connectionId, connection] of Object.entries(
    settings.providerConnections,
  )) {
    if (!settings.providers[connection.provider]) {
      details.push(
        `provider_connections.${connectionId}.provider references unknown provider ${connection.provider}.`,
      );
    }
  }

  for (const [conversationId, conversation] of Object.entries(
    settings.conversations,
  )) {
    const connection =
      settings.providerConnections[conversation.providerConnection];
    if (!connection) {
      details.push(
        `conversations.${conversationId}.provider_connection references unknown provider connection ${conversation.providerConnection}.`,
      );
    }
    if (
      conversation.kind !== 'dm' &&
      conversation.kind !== 'direct' &&
      conversation.controlApprovers.length === 0
    ) {
      details.push(
        `conversations.${conversationId}.control_approvers must include at least one conversation approver.`,
      );
    }
    const explicitProviderId = explicitProviderIdForExternalId(
      conversation.externalId,
    );
    const expectedProviderId = connection
      ? normalizeProviderId(connection.provider)
      : '';
    if (
      explicitProviderId &&
      expectedProviderId &&
      explicitProviderId !== expectedProviderId
    ) {
      details.push(
        `conversations.${conversationId}.external_id prefix "${explicitProviderId}:" does not match provider connection ${conversation.providerConnection} (${expectedProviderId}).`,
      );
    }
  }

  for (const [agentId, agent] of Object.entries(settings.agents)) {
    for (const capability of agent.capabilities) {
      const toolRule =
        capability.id === 'browser.use'
          ? 'Browser'
          : capability.id.includes('.') &&
              !capability.id.startsWith('RunCommand(')
            ? `capability:${capability.id}`
            : capability.id;
      const validation = validateReadableAgentToolRule(toolRule);
      if (!validation.ok) {
        details.push(
          `agents.${agentId}.capabilities contains invalid capability "${capability.id}": ${validation.reason}`,
        );
      }
    }
  }

  if (
    settings.memory.embeddings.enabled &&
    settings.memory.embeddings.provider === 'disabled'
  ) {
    details.push(
      'memory.embeddings.provider cannot be disabled when memory.embeddings.enabled is true.',
    );
  }
  if (settings.memory.dreaming.enabled && !settings.memory.enabled) {
    details.push('memory.dreaming.enabled requires memory.enabled=true.');
  }
  if (
    settings.memory.dreaming.embeddings.enabled &&
    settings.memory.dreaming.embeddings.provider === 'disabled'
  ) {
    details.push(
      'memory.dreaming.embeddings.provider cannot be disabled when memory.dreaming.embeddings.enabled is true.',
    );
  }

  if (details.length > 0) {
    return {
      ok: false,
      settings,
      failure: {
        summary: 'settings file is invalid for the current runtime',
        details,
      },
    };
  }

  return { ok: true, settings };
}

function explicitProviderIdForExternalId(value: string): string | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const providerId = normalizeProviderId(value.slice(0, separator));
  return providerId || null;
}

export function runtimeSettingsValidationError(
  runtimeHome: string,
  err: unknown,
): RuntimeSettingsValidationResult {
  return {
    ok: false,
    failure: {
      summary: 'settings file is invalid',
      details: [
        `File: ${settingsFilePath(runtimeHome)}`,
        err instanceof Error ? err.message : String(err),
      ],
    },
  };
}
