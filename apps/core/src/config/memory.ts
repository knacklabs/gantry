import { runtimeMemorySettings } from './memory-state.js';
import {
  DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS,
  DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE,
  DEFAULT_OPENAI_DAILY_EMBED_LIMIT,
} from './settings/runtime-settings-defaults.js';
import {
  MEMORY_MODEL_DEFAULT_ALIASES,
  resolveCatalogRunnerModel,
} from '../shared/model-catalog.js';

export {
  RUNTIME_MEMORY_DREAMING_ENABLED,
  RUNTIME_MEMORY_ENABLED,
} from './memory-state.js';
export * from './memory-advanced.js';

export const OPENAI_DAILY_EMBED_LIMIT =
  runtimeMemorySettings.dailyEmbedLimit ?? DEFAULT_OPENAI_DAILY_EMBED_LIMIT;

export const MEMORY_EMBED_MODEL =
  runtimeMemorySettings.embeddingModel || 'text-embedding-3-large';

export const MEMORY_EMBED_PROVIDER =
  runtimeMemorySettings.embeddingsEnabled === false
    ? 'disabled'
    : runtimeMemorySettings.embeddingProvider || 'disabled';

export const MEMORY_DREAMING_EMBEDDINGS_ENABLED =
  runtimeMemorySettings.dreamingEmbeddingsEnabled === true;

export const MEMORY_DREAMING_EMBED_PROVIDER =
  runtimeMemorySettings.dreamingEmbeddingsEnabled === false
    ? 'disabled'
    : runtimeMemorySettings.dreamingEmbeddingProvider ||
      runtimeMemorySettings.embeddingProvider ||
      'disabled';

export const MEMORY_DREAMING_EMBED_MODEL =
  runtimeMemorySettings.dreamingEmbeddingModel ||
  runtimeMemorySettings.embeddingModel ||
  MEMORY_EMBED_MODEL;

export const MEMORY_EXTRACTOR_MAX_FACTS =
  runtimeMemorySettings.extractorMaxFacts ?? DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS;

export const MEMORY_EXTRACTOR_MIN_CONFIDENCE = Math.max(
  0,
  Math.min(
    1,
    runtimeMemorySettings.extractorMinConfidence ??
      DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE,
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
