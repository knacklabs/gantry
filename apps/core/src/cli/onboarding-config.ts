import { upsertEnvFile } from './env-file.js';
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
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  openAiApiKey?: string;
}

export function persistOnboardingConfig(input: OnboardingConfigInput): void {
  ensureRuntimeLayout(input.runtimeHome);
  savePreferredRuntimeHome(input.runtimeHome);

  const memoryProvider = input.memoryEnabled ? 'sqlite' : 'noop';
  const embeddingProvider =
    input.memoryEnabled && input.embeddingsEnabled ? 'openai' : 'disabled';

  upsertEnvFile(envFilePath(input.runtimeHome), {
    TELEGRAM_BOT_TOKEN: input.telegramBotToken.trim(),
    MEMORY_PROVIDER: memoryProvider,
    MEMORY_EMBED_PROVIDER: embeddingProvider,
    MEMORY_DREAMING_ENABLED: input.dreamingEnabled ? 'true' : 'false',
    OPENAI_API_KEY:
      input.embeddingsEnabled && input.openAiApiKey?.trim()
        ? input.openAiApiKey.trim()
        : null,
  });

  const settings = loadRuntimeSettings(input.runtimeHome);
  settings.channels.telegram.enabled = Boolean(input.telegramBotToken.trim());
  settings.features = {
    memory: input.memoryEnabled,
    embeddings: input.memoryEnabled && input.embeddingsEnabled,
    dreaming: input.dreamingEnabled,
  };
  saveRuntimeSettings(input.runtimeHome, settings);
}
