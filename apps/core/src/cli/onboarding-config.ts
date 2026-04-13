import { upsertEnvFile } from './env-file.js';
import {
  envFilePath,
  ensureRuntimeLayout,
  savePreferredRuntimeHome,
} from './runtime-home.js';

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
}
