import { upsertEnvFile } from './env-file.js';
import type { HostCredentialMode } from '../core/credential-mode.js';
import {
  envFilePath,
  ensureRuntimeLayout,
  savePreferredRuntimeHome,
} from './runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from './runtime-settings.js';

export interface OnboardingConfigInput {
  runtimeHome: string;
  telegramBotToken: string;
  credentialMode: HostCredentialMode;
  onecliUrl?: string;
  memoryEnabled: boolean;
  memoryProvider?: 'sqlite' | 'qmd' | 'noop';
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  openAiApiKey?: string;
}

export function persistOnboardingConfig(input: OnboardingConfigInput): void {
  ensureRuntimeLayout(input.runtimeHome);
  savePreferredRuntimeHome(input.runtimeHome);

  const onecliUrl = input.onecliUrl?.trim() || '';

  upsertEnvFile(envFilePath(input.runtimeHome), {
    TELEGRAM_BOT_TOKEN: input.telegramBotToken.trim(),
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
  settings.channels.telegram.enabled = Boolean(input.telegramBotToken.trim());
  settings.memory = {
    ...settings.memory,
    enabled: input.memoryEnabled,
    provider: input.memoryEnabled ? input.memoryProvider || 'sqlite' : 'noop',
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
