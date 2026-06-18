import { randomBytes } from 'node:crypto';

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
  isModelPresetId,
  resolveModelSelectionForWorkload,
  type ModelPresetId,
} from '../shared/model-catalog.js';

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
  credentialMode: HostCredentialMode;
  agentName?: string;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
}

export function persistOnboardingConfig(input: OnboardingConfigInput): void {
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
    SECRET_ENCRYPTION_KEY: input.postgresDatabaseUrl?.trim()
      ? credentialSecretEncryptionKey
      : null,
    OPENAI_API_KEY: null,
  });

  const settings = loadRuntimeSettings(input.runtimeHome);
  if (input.agentName?.trim()) {
    settings.agent.name = input.agentName.trim();
  }
  settings.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
  settings.storage.postgres.schema = input.postgresSchema?.trim() || 'gantry';
  const model = resolveOnboardingModel(input.modelAlias);
  // The preset governs the memory/defaults cascade. A non-preset (DeepAgents-
  // lane) chat model legitimately pairs with any preset, so only fall back to
  // the model's provider as the preset when it is itself a preset id.
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
  applyModelPreset(settings, preset);
  if (model.alias) {
    settings.agent.defaultModel = model.alias;
  }
  settings.credentialBroker.mode = input.credentialMode;
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
