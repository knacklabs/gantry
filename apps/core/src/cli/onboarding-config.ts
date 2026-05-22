import { readEnvFile, upsertEnvFile } from '../config/env/file.js';
import type { HostCredentialMode } from '../config/credentials/mode.js';
import '../channels/register-builtins.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import {
  applyModelPreset,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import {
  DEFAULT_MODEL_PRESET_ID,
  resolveModelSelectionForWorkload,
  type ModelPresetId,
} from '../shared/model-catalog.js';
import {
  generateOnecliSecretEncryptionKey,
  ONECLI_DATABASE_URL_ENV,
  ONECLI_DEFAULT_SCHEMA,
  ONECLI_SECRET_ENCRYPTION_KEY_ENV,
  validateSharedPostgresDatabase,
  validateOnecliSecretEncryptionKey,
} from '../adapters/credentials/onecli/local/persistence.js';

export interface OnboardingConfigInput {
  runtimeHome: string;
  postgresDatabaseUrl?: string;
  postgresSchema?: string;
  onecliPostgresDatabaseUrl?: string;
  onecliPostgresSchema?: string;
  primaryProvider: 'telegram' | 'slack';
  telegramBotToken?: string;
  telegramPermissionApproverIds?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackPermissionApproverIds?: string;
  modelPreset?: ModelPresetId;
  modelAlias?: string;
  credentialMode: HostCredentialMode;
  onecliUrl?: string;
  agentName?: string;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
}

export function persistOnboardingConfig(input: OnboardingConfigInput): void {
  ensureRuntimeLayout(input.runtimeHome);

  const onecliUrl = input.onecliUrl?.trim() || '';
  const envPath = envFilePath(input.runtimeHome);
  const existingEnv = readEnvFile(envPath);
  const onecliPostgresSchema =
    input.onecliPostgresSchema?.trim() || ONECLI_DEFAULT_SCHEMA;
  const onecliDatabaseUrl = input.onecliPostgresDatabaseUrl?.trim() || null;
  if (input.postgresDatabaseUrl?.trim() && !onecliDatabaseUrl) {
    throw new Error(
      'ONECLI_DATABASE_URL is required and must use a Postgres role separate from GANTRY_DATABASE_URL.',
    );
  }
  if (input.postgresDatabaseUrl?.trim() && onecliDatabaseUrl) {
    const sharedDatabase = validateSharedPostgresDatabase({
      gantryPostgresUrl: input.postgresDatabaseUrl.trim(),
      onecliPostgresUrl: onecliDatabaseUrl,
    });
    if (!sharedDatabase.ok) {
      throw new Error(sharedDatabase.message);
    }
  }
  const existingOnecliSecret =
    existingEnv[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim() ||
    process.env[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim() ||
    '';
  const onecliSecretEncryptionKey = validateOnecliSecretEncryptionKey(
    existingOnecliSecret,
  ).ok
    ? existingOnecliSecret
    : generateOnecliSecretEncryptionKey();

  upsertEnvFile(envPath, {
    TELEGRAM_BOT_TOKEN: input.telegramBotToken?.trim() || null,
    SLACK_BOT_TOKEN: input.slackBotToken?.trim() || null,
    SLACK_APP_TOKEN: input.slackAppToken?.trim() || null,
    SLACK_PERMISSION_APPROVER_IDS: null,
    CLAUDE_CODE_OAUTH_TOKEN: null,
    ANTHROPIC_API_KEY: null,
    ANTHROPIC_AUTH_TOKEN: null,
    ANTHROPIC_MODEL: null,
    ANTHROPIC_DEFAULT_OPUS_MODEL: null,
    ANTHROPIC_DEFAULT_SONNET_MODEL: null,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: null,
    GANTRY_DATABASE_URL: input.postgresDatabaseUrl?.trim() || null,
    [ONECLI_DATABASE_URL_ENV]: onecliDatabaseUrl,
    [ONECLI_SECRET_ENCRYPTION_KEY_ENV]: onecliDatabaseUrl
      ? onecliSecretEncryptionKey
      : null,
    GANTRY_CREDENTIAL_MODE: null,
    ONECLI_URL: null,
    OPENAI_API_KEY: null,
  });

  const settings = loadRuntimeSettings(input.runtimeHome);
  if (input.agentName?.trim()) {
    settings.agent.name = input.agentName.trim();
  }
  settings.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
  settings.storage.postgres.schema = input.postgresSchema?.trim() || 'gantry';
  const model = resolveOnboardingModel(input.modelAlias);
  const preset = input.modelPreset ?? model.preset ?? DEFAULT_MODEL_PRESET_ID;
  if (model.preset && model.preset !== preset) {
    throw new Error(
      `Selected model alias "${model.alias}" belongs to ${model.preset}, not ${preset}.`,
    );
  }
  applyModelPreset(settings, preset);
  if (model.alias) {
    settings.agent.defaultModel = model.alias;
  }
  settings.credentialBroker.mode = input.credentialMode;
  settings.credentialBroker.onecli.url = onecliUrl;
  settings.credentialBroker.onecli.postgres.urlEnv = ONECLI_DATABASE_URL_ENV;
  settings.credentialBroker.onecli.postgres.schema = onecliPostgresSchema;
  settings.providers.telegram.enabled =
    input.primaryProvider === 'telegram' && Boolean(input.telegramBotToken);
  settings.providers.slack.enabled =
    input.primaryProvider === 'slack' &&
    Boolean(input.slackBotToken) &&
    Boolean(input.slackAppToken);
  settings.memory = {
    ...settings.memory,
    enabled: input.memoryEnabled,
    embeddings: {
      ...settings.memory.embeddings,
      enabled: input.memoryEnabled && input.embeddingsEnabled,
      provider:
        input.memoryEnabled && input.embeddingsEnabled ? 'openai' : 'disabled',
    },
    dreaming: {
      ...settings.memory.dreaming,
      enabled: input.memoryEnabled && input.dreamingEnabled,
    },
  };
  saveRuntimeSettings(input.runtimeHome, settings);
}

function resolveOnboardingModel(value: string | undefined): {
  alias: string;
  preset?: ModelPresetId;
} {
  const trimmed = value?.trim();
  if (!trimmed) return { alias: '' };
  const resolved = resolveModelSelectionForWorkload(trimmed, 'chat');
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }
  return { alias: resolved.alias, preset: resolved.entry.modelRoute.id };
}
