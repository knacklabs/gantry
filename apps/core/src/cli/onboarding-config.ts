import { randomBytes } from 'node:crypto';

import { readEnvFile, upsertEnvFile } from '../config/env/file.js';
import type { HostCredentialMode } from '../config/credentials/mode.js';
import type { AgentHarness } from '../shared/agent-engine.js';
import '../channels/register-builtins.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import {
  applyModelPreset,
  loadDesiredRuntimeSettingsForWrite,
  loadRuntimeSettings,
  writeDesiredRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import {
  DEFAULT_MODEL_PRESET_ID,
  isModelPresetId,
  resolveModelSelectionForWorkload,
  type ModelPresetId,
} from '../shared/model-catalog.js';
import { gantryRuntimeSecretRef } from '../domain/ports/runtime-secret-provider.js';
import { runPostgresMigrations } from '../postgres-migrate.js';
import { storeRuntimeSecretInput } from './credentials.js';

export interface OnboardingConfigInput {
  runtimeHome: string;
  postgresDatabaseUrl?: string;
  postgresSchema?: string;
  primaryProvider: 'telegram' | 'slack';
  telegramBotToken?: string;
  telegramPermissionApproverIds?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackPermissionApproverIds?: string;
  modelPreset?: ModelPresetId;
  modelAlias?: string;
  agentHarness?: AgentHarness;
  credentialMode: HostCredentialMode;
  agentName?: string;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
}

export async function persistOnboardingConfig(
  input: OnboardingConfigInput,
): Promise<void> {
  ensureRuntimeLayout(input.runtimeHome);

  const envPath = envFilePath(input.runtimeHome);
  const existingEnv = readEnvFile(envPath);
  const existingCredentialSecret =
    existingEnv.SECRET_ENCRYPTION_KEY?.trim() ||
    process.env.SECRET_ENCRYPTION_KEY?.trim() ||
    '';
  const credentialSecretEncryptionKey = isValidCredentialEncryptionKey(
    existingCredentialSecret,
  )
    ? existingCredentialSecret
    : randomBytes(32).toString('base64');

  upsertEnvFile(envPath, {
    CLAUDE_CODE_OAUTH_TOKEN: null,
    ANTHROPIC_API_KEY: null,
    ANTHROPIC_AUTH_TOKEN: null,
    ANTHROPIC_MODEL: null,
    ANTHROPIC_DEFAULT_OPUS_MODEL: null,
    ANTHROPIC_DEFAULT_SONNET_MODEL: null,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: null,
    GANTRY_DATABASE_URL: input.postgresDatabaseUrl?.trim() || null,
    SECRET_ENCRYPTION_KEY: input.postgresDatabaseUrl?.trim()
      ? credentialSecretEncryptionKey
      : null,
    OPENAI_API_KEY: null,
  });
  if (input.postgresDatabaseUrl?.trim()) {
    process.env.GANTRY_DATABASE_URL = input.postgresDatabaseUrl.trim();
    process.env.SECRET_ENCRYPTION_KEY = credentialSecretEncryptionKey;
  }

  const model = resolveOnboardingModel(input.modelAlias);
  // The preset governs chat plus memory LLM defaults. Embeddings are handled
  // separately and use the registered OpenAI embedding provider when enabled.
  // A non-preset (DeepAgents-lane) chat model legitimately pairs with any
  // preset, so only fall back to the model's provider as the preset when it is
  // itself a preset id.
  const modelPresetId =
    model.preset && isModelPresetId(model.preset) ? model.preset : undefined;
  const preset = input.modelPreset ?? modelPresetId ?? DEFAULT_MODEL_PRESET_ID;
  // Only a cross-PRESET mismatch is an error (e.g. an OpenRouter model selected
  // under the Anthropic preset); non-preset chat models pair with any preset.
  if (modelPresetId && modelPresetId !== preset) {
    throw new Error(
      `Selected model alias "${model.alias}" belongs to ${modelPresetId}, not ${preset}.`,
    );
  }
  const postgresSchema = input.postgresSchema?.trim() || 'gantry';
  if (input.postgresDatabaseUrl?.trim()) {
    await runPostgresMigrations({
      url: input.postgresDatabaseUrl.trim(),
      schema: postgresSchema,
    });
  }
  const settingsSeed = loadRuntimeSettings(input.runtimeHome);
  settingsSeed.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
  settingsSeed.storage.postgres.schema = postgresSchema;
  const settings = await loadDesiredRuntimeSettingsForWrite({
    runtimeHome: input.runtimeHome,
    settings: settingsSeed,
  });
  const previousSettings = structuredClone(settings);
  if (input.agentName?.trim()) {
    settings.agent.name = input.agentName.trim();
  }
  settings.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
  settings.storage.postgres.schema = postgresSchema;
  let previousSettingsForFinalWrite = previousSettings;
  const storesRuntimeSecrets = Boolean(
    input.telegramBotToken?.trim() ||
    (input.slackBotToken?.trim() && input.slackAppToken?.trim()),
  );
  if (storesRuntimeSecrets) {
    await writeDesiredRuntimeSettings({
      runtimeHome: input.runtimeHome,
      settings,
      previousSettings,
      createdBy: 'cli:onboarding',
    });
    previousSettingsForFinalWrite = structuredClone(settings);
  }
  applyModelPreset(settings, preset);
  if (model.alias) {
    settings.agent.defaultModel = model.alias;
  }
  if (input.agentHarness) {
    settings.agent.agentHarness = input.agentHarness;
  }
  settings.credentialBroker.mode = input.credentialMode;
  settings.providers.telegram.enabled =
    input.primaryProvider === 'telegram' && Boolean(input.telegramBotToken);
  settings.providers.slack.enabled =
    input.primaryProvider === 'slack' &&
    Boolean(input.slackBotToken) &&
    Boolean(input.slackAppToken);
  const secretWrites: Promise<void>[] = [];
  if (input.telegramBotToken?.trim()) {
    secretWrites.push(
      storeRuntimeSecretInput({
        runtimeHome: input.runtimeHome,
        name: 'TELEGRAM_BOT_TOKEN',
        value: input.telegramBotToken.trim(),
        actor: 'cli:onboarding',
      }),
    );
    settings.providers.telegram.defaultConnection ||= 'telegram_default';
    settings.providerConnections[
      settings.providers.telegram.defaultConnection
    ] = {
      provider: 'telegram',
      label:
        settings.providerConnections[
          settings.providers.telegram.defaultConnection
        ]?.label || 'Telegram Default',
      runtimeSecretRefs: {
        ...(settings.providerConnections[
          settings.providers.telegram.defaultConnection
        ]?.runtimeSecretRefs || {}),
        bot_token: gantryRuntimeSecretRef('TELEGRAM_BOT_TOKEN'),
      },
    };
  }
  if (input.slackBotToken?.trim() && input.slackAppToken?.trim()) {
    secretWrites.push(
      storeRuntimeSecretInput({
        runtimeHome: input.runtimeHome,
        name: 'SLACK_BOT_TOKEN',
        value: input.slackBotToken.trim(),
        actor: 'cli:onboarding',
      }),
      storeRuntimeSecretInput({
        runtimeHome: input.runtimeHome,
        name: 'SLACK_APP_TOKEN',
        value: input.slackAppToken.trim(),
        actor: 'cli:onboarding',
      }),
    );
    settings.providers.slack.defaultConnection ||= 'slack_default';
    settings.providerConnections[settings.providers.slack.defaultConnection] = {
      provider: 'slack',
      label:
        settings.providerConnections[settings.providers.slack.defaultConnection]
          ?.label || 'Slack Default',
      runtimeSecretRefs: {
        ...(settings.providerConnections[
          settings.providers.slack.defaultConnection
        ]?.runtimeSecretRefs || {}),
        bot_token: gantryRuntimeSecretRef('SLACK_BOT_TOKEN'),
        app_token: gantryRuntimeSecretRef('SLACK_APP_TOKEN'),
      },
    };
  }
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
  await Promise.all(secretWrites);
  await writeDesiredRuntimeSettings({
    runtimeHome: input.runtimeHome,
    settings,
    previousSettings: previousSettingsForFinalWrite,
    createdBy: 'cli:onboarding',
  });
  upsertEnvFile(envPath, {
    TELEGRAM_BOT_TOKEN: null,
    SLACK_BOT_TOKEN: null,
    SLACK_APP_TOKEN: null,
    SLACK_PERMISSION_APPROVER_IDS: null,
  });
}

export async function prepareOnboardingCredentialStorage(input: {
  runtimeHome: string;
  postgresDatabaseUrl?: string;
  postgresSchema?: string;
}): Promise<void> {
  const postgresUrl = input.postgresDatabaseUrl?.trim();
  if (!postgresUrl) return;
  const postgresSchema = input.postgresSchema?.trim() || 'gantry';
  ensureRuntimeLayout(input.runtimeHome);
  const envPath = envFilePath(input.runtimeHome);
  const existingEnv = readEnvFile(envPath);
  const existingCredentialKey =
    existingEnv.SECRET_ENCRYPTION_KEY?.trim() ||
    process.env.SECRET_ENCRYPTION_KEY?.trim() ||
    '';
  const credentialKey = isValidCredentialEncryptionKey(existingCredentialKey)
    ? existingCredentialKey
    : randomBytes(32).toString('base64');
  upsertEnvFile(envPath, {
    GANTRY_DATABASE_URL: postgresUrl,
    GANTRY_SETTINGS_POSTGRES_SCHEMA: postgresSchema,
    SECRET_ENCRYPTION_KEY: credentialKey,
  });
  process.env.GANTRY_HOME = input.runtimeHome;
  process.env.GANTRY_DATABASE_URL = postgresUrl;
  process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA = postgresSchema;
  process.env.SECRET_ENCRYPTION_KEY = credentialKey;
  await runPostgresMigrations({
    url: postgresUrl,
    schema: postgresSchema,
  });
}

function isValidCredentialEncryptionKey(raw: string): boolean {
  if (!raw) return false;
  return Buffer.from(raw, 'base64').length === 32;
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
