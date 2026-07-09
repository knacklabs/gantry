import {
  getProvider,
  normalizeProviderId,
} from '../../channels/provider-registry.js';
import {
  fleetRehearsalPlaintextPostgresHosts,
  validatePostgresConnectionUrl,
} from '../../adapters/storage/postgres/url.js';
import { readEnvFile } from '../env/file.js';
import { validateRuntimeEnvPolicy } from '../source-classification.js';
import {
  DEFAULT_SETUP_MODEL_ALIAS,
  resolveModelSelectionForWorkload,
  type ModelWorkload,
} from '../../shared/model-catalog.js';
import { hasValidEncryptionSecret } from '../../shared/security-posture.js';
import { validateDurableAccessRule } from '../../shared/durable-access-policy.js';
import {
  isForbiddenRuntimeSecretEnvName,
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../../domain/ports/runtime-secret-provider.js';
import {
  isProviderRuntimeSecretRefTarget,
  runtimeSecretKeyForEnv,
} from '../../domain/provider/provider-runtime-secret-keys.js';
import { envFilePath, settingsFilePath } from './runtime-home.js';
import type {
  RuntimeSettings,
  RuntimeSettingsValidationResult,
} from './runtime-settings-types.js';
import {
  formatInlineAgentWorkerOnlyConfigError,
  inlineWorkerOnlyConfiguredCapabilityLabels,
} from './runtime-settings-agent-runtime.js';

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
  const postgresPlaintextHostAllowlist = fleetRehearsalPlaintextPostgresHosts({
    ...env,
    ...process.env,
  });
  if (!postgresUrl) {
    details.push(`${postgresUrlEnv} is required for runtime storage.`);
  } else {
    try {
      validatePostgresConnectionUrl(postgresUrl, {
        allowLocalhost: true,
        plaintextHostAllowlist: postgresPlaintextHostAllowlist,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      details.push(`${postgresUrlEnv} is invalid: ${message}`);
    }
  }

  const enabledProviderIds = Object.entries(settings.providers)
    .filter(([, provider]) => provider.enabled)
    .map(([providerId]) => providerId);

  if (
    settings.credentialBroker.mode === 'gantry' ||
    enabledProviderUsesStoredRuntimeSecretRefs(settings, enabledProviderIds)
  ) {
    const secretValidation = validateCredentialEncryptionSecret({
      SECRET_ENCRYPTION_KEY:
        process.env.SECRET_ENCRYPTION_KEY?.trim() ||
        env.SECRET_ENCRYPTION_KEY?.trim(),
      SECRET_ENCRYPTION_KEYRING_JSON:
        process.env.SECRET_ENCRYPTION_KEYRING_JSON?.trim() ||
        env.SECRET_ENCRYPTION_KEYRING_JSON?.trim(),
    });
    if (!secretValidation.ok) details.push(secretValidation.message);
  }

  for (const providerId of enabledProviderIds) {
    const provider = getProvider(providerId);
    if (!provider) {
      details.push(
        `providers.${providerId}.enabled is true but no provider is registered for '${providerId}'.`,
      );
      continue;
    }

    const accounts = Object.entries(settings.providerAccounts).filter(
      ([, account]) =>
        account.provider === provider.id && account.status !== 'disabled',
    );
    if (accounts.length === 0) {
      details.push(
        `providers.${provider.id}.enabled is true but no active provider account is configured.`,
      );
      continue;
    }
    for (const [accountId, account] of accounts) {
      for (const envKey of provider.setup.envKeys) {
        const credential = validateProviderCredentialRef({
          env,
          accountId,
          account,
          envKey,
        });
        if (!credential.ok) {
          details.push(credential.message);
        }
      }
    }
  }

  for (const [connectionId, connection] of Object.entries(
    settings.providerAccounts,
  )) {
    if (!settings.providers[connection.provider]) {
      details.push(
        `provider_accounts.${connectionId}.provider references unknown provider ${connection.provider}.`,
      );
    }
  }

  for (const [conversationId, conversation] of Object.entries(
    settings.conversations,
  )) {
    const connection =
      settings.providerAccounts[
        conversation.providerAccount ?? conversation.providerConnection
      ];
    if (!connection) {
      details.push(
        `conversations.${conversationId}.provider_account references unknown provider account ${conversation.providerAccount ?? conversation.providerConnection}.`,
      );
    }
    if (
      connection?.provider !== 'app' &&
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
        `conversations.${conversationId}.external_id prefix "${explicitProviderId}:" does not match provider account ${conversation.providerAccount ?? conversation.providerConnection} (${expectedProviderId}).`,
      );
    }
  }

  for (const [agentId, agent] of Object.entries(settings.agents)) {
    const inlineBlockers = inlineWorkerOnlyConfiguredCapabilityLabels({
      agent,
    });
    if (inlineBlockers.length > 0) {
      details.push(
        formatInlineAgentWorkerOnlyConfigError(
          `agents.${agentId}`,
          inlineBlockers,
        ),
      );
    }
    const effectiveModel = (
      agent.model ||
      settings.agent.defaultModel ||
      DEFAULT_SETUP_MODEL_ALIAS
    ).trim();
    const modelResolution = resolveModelSelectionForWorkload(
      effectiveModel,
      'chat',
    );
    if (!modelResolution.ok) {
      details.push(
        `agents.${agentId}.model is invalid: ${modelResolution.message}`,
      );
    }
    for (const capability of agent.capabilities) {
      const toolRule =
        capability.id === 'browser.use'
          ? 'Browser'
          : capability.id.includes('.') &&
              !capability.id.startsWith('RunCommand(')
            ? `capability:${capability.id}`
            : capability.id;
      const validation = validateDurableAccessRule(toolRule, {
        allowUnknownSemanticCapability: true,
      });
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

function validateCredentialEncryptionSecret(env: {
  SECRET_ENCRYPTION_KEY?: string;
  SECRET_ENCRYPTION_KEYRING_JSON?: string;
}): {
  ok: boolean;
  message: string;
} {
  if (hasValidEncryptionSecret(env)) {
    return {
      ok: true,
      message:
        'SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON is configured.',
    };
  }
  return {
    ok: false,
    message:
      'SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON must provide a strong base64-encoded 32-byte active key for Gantry credential encryption.',
  };
}

function enabledProviderUsesStoredRuntimeSecretRefs(
  settings: RuntimeSettings,
  enabledProviderIds: string[],
): boolean {
  for (const providerId of enabledProviderIds) {
    const accounts = Object.values(settings.providerAccounts).filter(
      (account) =>
        account.provider === providerId && account.status !== 'disabled',
    );
    const refs =
      accounts.length > 0
        ? accounts.flatMap((account) =>
            Object.values(account.runtimeSecretRefs),
          )
        : [];
    for (const ref of refs) {
      try {
        const parsed = parseRuntimeSecretRefString(
          normalizeRuntimeSecretRefString(ref),
        );
        if (parsed.source === 'gantry-secret') return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

function validateProviderCredentialRef(input: {
  env: Record<string, string | undefined>;
  accountId: string;
  account: RuntimeSettings['providerAccounts'][string];
  envKey: string;
}): { ok: true } | { ok: false; message: string } {
  const refKey = runtimeSecretKeyForEnv(input.account.provider, input.envKey);
  const ref = input.account.runtimeSecretRefs[refKey];
  const value = ref?.trim();
  if (!value) {
    return {
      ok: false,
      message: `provider_accounts.${input.accountId}.runtime_secret_refs.${refKey} is required when provider '${input.account.provider}' is enabled.`,
    };
  }

  let normalized: string;
  let source: ReturnType<typeof parseRuntimeSecretRefString>['source'];
  let refName: string;
  try {
    normalized = normalizeRuntimeSecretRefString(value);
    const parsed = parseRuntimeSecretRefString(normalized);
    source = parsed.source;
    refName = parsed.name;
  } catch (err) {
    return {
      ok: false,
      message: `provider_accounts.${input.accountId}.runtime_secret_refs.${refKey} is invalid: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (source === 'env') {
    if (isForbiddenRuntimeSecretEnvName(refName)) {
      return {
        ok: false,
        message: `${refName} is not allowed for provider '${input.account.provider}' runtime secret ref ${normalized}. Use a channel runtime secret name, not model/provider credential authority.`,
      };
    }
    if (
      !isProviderRuntimeSecretRefTarget(
        input.account.provider,
        refKey,
        normalized,
      )
    ) {
      return {
        ok: false,
        message: `provider_accounts.${input.accountId}.runtime_secret_refs.${refKey} must point to ${input.envKey}.`,
      };
    }
    if (input.env[refName]?.trim() || process.env[refName]?.trim()) {
      return { ok: true };
    }
    return {
      ok: false,
      message: `${refName} is required because provider '${input.account.provider}' runtime secret ref ${normalized} resolves from env.`,
    };
  }

  if (
    !isProviderRuntimeSecretRefTarget(
      input.account.provider,
      refKey,
      normalized,
    )
  ) {
    return {
      ok: false,
      message: `provider_accounts.${input.accountId}.runtime_secret_refs.${refKey} must point to ${input.envKey}.`,
    };
  }

  return { ok: true };
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
