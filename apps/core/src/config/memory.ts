import { envConfig } from './env/index.js';
import { runtimeMemorySettings } from './memory-state.js';
import {
  MEMORY_MODEL_DEFAULT_ALIASES,
  resolveCatalogRunnerModel,
} from '../shared/model-catalog.js';

export { RUNTIME_MEMORY_ENABLED } from './memory-state.js';
export * from './memory-advanced.js';

export const OPENAI_DAILY_EMBED_LIMIT = Math.max(
  0,
  parseInt(
    process.env.OPENAI_DAILY_EMBED_LIMIT ||
      envConfig.OPENAI_DAILY_EMBED_LIMIT ||
      '500',
    10,
  ),
);

export const MEMORY_EMBED_MODEL =
  runtimeMemorySettings.embeddingModel || 'text-embedding-3-large';

export const MEMORY_EMBED_PROVIDER =
  runtimeMemorySettings.embeddingsEnabled === false
    ? 'disabled'
    : runtimeMemorySettings.embeddingProvider || 'disabled';

export const MEMORY_EXTRACTOR_MAX_FACTS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_EXTRACTOR_MAX_FACTS ||
      envConfig.MEMORY_EXTRACTOR_MAX_FACTS ||
      '8',
    10,
  ) || 8,
);

export const MEMORY_EXTRACTOR_MIN_CONFIDENCE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_EXTRACTOR_MIN_CONFIDENCE ||
        envConfig.MEMORY_EXTRACTOR_MIN_CONFIDENCE ||
        '0.6',
    ) || 0.6,
  ),
);

function resolveMemoryLlmModel(
  configuredModel: string | undefined,
  defaultModel: string,
  anthropicModel: string | undefined,
): string {
  return (
    resolveCatalogRunnerModel(configuredModel) || anthropicModel || defaultModel
  );
}

export function getMemoryModelConfig(anthropicModel: string | undefined): {
  extractor: string;
  dreaming: string;
  consolidation: string;
} {
  return {
    extractor: resolveMemoryLlmModel(
      runtimeMemorySettings.llmExtractorModel,
      MEMORY_MODEL_DEFAULT_ALIASES.extractor,
      anthropicModel,
    ),
    dreaming: resolveMemoryLlmModel(
      runtimeMemorySettings.llmDreamingModel,
      MEMORY_MODEL_DEFAULT_ALIASES.dreaming,
      anthropicModel,
    ),
    consolidation: resolveMemoryLlmModel(
      runtimeMemorySettings.llmConsolidationModel,
      MEMORY_MODEL_DEFAULT_ALIASES.consolidation,
      anthropicModel,
    ),
  };
}
