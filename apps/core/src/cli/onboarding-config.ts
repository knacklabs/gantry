import { upsertEnvFile } from './env-file.js';
import type { HostCredentialMode } from '../core/credential-mode.js';
import '../channels/register-builtins.js';
import { getChannelProvider } from '../channels/provider-registry.js';
import { envFilePath, ensureRuntimeLayout } from './runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from './runtime-settings.js';

export interface OnboardingConfigInput {
  runtimeHome: string;
  storageProvider: 'sqlite';
  primaryProvider: 'telegram' | 'slack';
  telegramBotToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  claudeOauthToken?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  credentialMode: HostCredentialMode;
  onecliUrl?: string;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  openAiApiKey?: string;
}

export function persistOnboardingConfig(input: OnboardingConfigInput): void {
  ensureRuntimeLayout(input.runtimeHome);

  const onecliUrl = input.onecliUrl?.trim() || '';

  upsertEnvFile(envFilePath(input.runtimeHome), {
    TELEGRAM_BOT_TOKEN: input.telegramBotToken?.trim() || null,
    SLACK_BOT_TOKEN: input.slackBotToken?.trim() || null,
    SLACK_APP_TOKEN: input.slackAppToken?.trim() || null,
    CLAUDE_CODE_OAUTH_TOKEN:
      input.credentialMode === 'onecli-only'
        ? null
        : input.claudeOauthToken?.trim() || null,
    ANTHROPIC_API_KEY:
      input.credentialMode === 'onecli-only'
        ? null
        : input.anthropicApiKey?.trim() || null,
    ANTHROPIC_MODEL: input.anthropicModel?.trim() || null,
    MYCLAW_DATABASE_URL: null,
    MYCLAW_CREDENTIAL_MODE: input.credentialMode,
    ONECLI_URL:
      input.credentialMode === 'env-only'
        ? null
        : onecliUrl.length > 0
          ? onecliUrl
          : null,
    OPENAI_API_KEY:
      input.embeddingsEnabled && input.openAiApiKey?.trim()
        ? input.openAiApiKey.trim()
        : null,
  });

  const settings = loadRuntimeSettings(input.runtimeHome);
  settings.storage.provider = input.storageProvider;
  settings.storage.postgres.urlEnv = 'MYCLAW_DATABASE_URL';
  settings.storage.postgres.schema = 'myclaw';
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
