import { readEnvFile, upsertEnvFile } from '../config/env/file.js';
import type { HostCredentialMode } from '../config/credentials/mode.js';
import '../channels/register-builtins.js';
import { getChannelProvider } from '../channels/provider-registry.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { normalizeClaudeModelSelection } from '../models/claude-model-registry.js';
import { parseSenderControlAllowlistConfig } from '../config/settings/control-allowlist.js';
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
  anthropicModel?: string;
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
      'ONECLI_DATABASE_URL is required and must use a Postgres role separate from MYCLAW_DATABASE_URL.',
    );
  }
  if (input.postgresDatabaseUrl?.trim() && onecliDatabaseUrl) {
    const sharedDatabase = validateSharedPostgresDatabase({
      myclawPostgresUrl: input.postgresDatabaseUrl.trim(),
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
    MYCLAW_DATABASE_URL: input.postgresDatabaseUrl?.trim() || null,
    [ONECLI_DATABASE_URL_ENV]: onecliDatabaseUrl,
    [ONECLI_SECRET_ENCRYPTION_KEY_ENV]: onecliDatabaseUrl
      ? onecliSecretEncryptionKey
      : null,
    MYCLAW_CREDENTIAL_MODE: null,
    ONECLI_URL: null,
    OPENAI_API_KEY: null,
  });

  const settings = loadRuntimeSettings(input.runtimeHome);
  if (input.agentName?.trim()) {
    settings.agent.name = input.agentName.trim();
  }
  settings.storage.postgres.urlEnv = 'MYCLAW_DATABASE_URL';
  settings.storage.postgres.schema = input.postgresSchema?.trim() || 'myclaw';
  settings.agent.defaultModel =
    normalizeClaudeModelSelection(input.anthropicModel) || '';
  settings.credentialBroker.mode = input.credentialMode;
  settings.credentialBroker.onecli.url = onecliUrl;
  settings.credentialBroker.onecli.postgres.urlEnv = ONECLI_DATABASE_URL_ENV;
  settings.credentialBroker.onecli.postgres.schema = onecliPostgresSchema;
  const telegramProvider = getChannelProvider('telegram');
  if (telegramProvider && settings.channels[telegramProvider.id]) {
    const shouldEnable =
      input.primaryProvider === 'telegram' && Boolean(input.telegramBotToken);
    settings.channels[telegramProvider.id].enabled = shouldEnable;
  }
  const slackProvider = getChannelProvider('slack');
  if (slackProvider && settings.channels[slackProvider.id]) {
    const shouldEnable =
      input.primaryProvider === 'slack' &&
      Boolean(input.slackBotToken) &&
      Boolean(input.slackAppToken);
    settings.channels[slackProvider.id].enabled = shouldEnable;
    if (input.primaryProvider === 'slack') {
      const approvers = parseApproverIds(input.slackPermissionApproverIds);
      settings.channels[slackProvider.id].controlAllowlist =
        parseSenderControlAllowlistConfig(
          {
            default: approvers,
            agents: settings.channels[slackProvider.id].controlAllowlist.agents,
          },
          'channels.slack.control_allowlist',
        );
    }
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
      enabled: input.memoryEnabled && input.dreamingEnabled,
    },
  };
  saveRuntimeSettings(input.runtimeHome, settings);
}

function parseApproverIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}
