import { MEMORY_CONFIG_HOME, runtimeMemorySettings } from './memory-state.js';
import {
  DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS,
  DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE,
  DEFAULT_OPENAI_DAILY_EMBED_LIMIT,
} from './settings/runtime-settings-defaults.js';
import { readRuntimeMemorySettingsSnapshot } from './settings/runtime-settings-snapshots.js';
import type { RuntimeMemorySettingsSnapshot } from './settings/memory-snapshot.js';
import {
  MEMORY_MODEL_DEFAULT_ALIASES,
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
  type ModelWorkload,
} from '../shared/model-catalog.js';
import type { MemoryLlmModelProfile } from '../domain/ports/memory-llm-client.js';

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

function toMemoryLlmModelProfile(
  entry: ModelCatalogEntry,
): MemoryLlmModelProfile {
  return {
    alias: entry.recommendedAlias,
    runnerModel: entry.runnerModel,
    provider: entry.provider,
    providerLabel: entry.providerLabel,
    displayName: entry.displayName,
  };
}

function resolveMemoryLlmModelProfile(
  candidate: string | undefined,
  workload: ModelWorkload,
): MemoryLlmModelProfile | undefined {
  if (!candidate) return undefined;
  const resolved = resolveModelSelectionForWorkload(candidate, workload);
  if (resolved.ok) return toMemoryLlmModelProfile(resolved.entry);
  return undefined;
}

function resolveMemoryLlmModelSlot(
  configuredModel: string | undefined,
  defaultModel: string,
  fallbackModel: string | undefined,
  workload: ModelWorkload,
  label: string,
): { runnerModel: string; modelProfile?: MemoryLlmModelProfile } {
  const configured = configuredModel?.trim();
  if (configured) {
    const profile = resolveMemoryLlmModelProfile(configured, workload);
    if (!profile) {
      const resolved = resolveModelSelectionForWorkload(configured, workload);
      throw new Error(
        resolved.ok
          ? `Memory ${label} model "${configured}" is not usable for ${workload}.`
          : `Memory ${label} model "${configured}" is invalid: ${resolved.message}`,
      );
    }
    return {
      runnerModel: profile.runnerModel,
      modelProfile: profile,
    };
  }

  const profile =
    resolveMemoryLlmModelProfile(fallbackModel, workload) ||
    resolveMemoryLlmModelProfile(defaultModel, workload);
  if (!profile) {
    const candidate = fallbackModel || defaultModel;
    const resolved = resolveModelSelectionForWorkload(candidate, workload);
    throw new Error(
      resolved.ok
        ? `Memory ${label} default "${candidate}" is not usable for ${workload}.`
        : `Memory ${label} default "${candidate}" is invalid: ${resolved.message}`,
    );
  }
  return {
    runnerModel: profile.runnerModel,
    modelProfile: profile,
  };
}

function readCurrentMemoryModelSettings(): RuntimeMemorySettingsSnapshot {
  return readRuntimeMemorySettingsSnapshot(MEMORY_CONFIG_HOME);
}

export function getMemoryModelConfig(fallbackModel: string | undefined): {
  extractor: string;
  dreaming: string;
  consolidation: string;
  modelProfiles: {
    extractor?: MemoryLlmModelProfile;
    dreaming?: MemoryLlmModelProfile;
    consolidation?: MemoryLlmModelProfile;
  };
} {
  const current = readCurrentMemoryModelSettings();
  const extractor = resolveMemoryLlmModelSlot(
    current.llmExtractorModel,
    MEMORY_MODEL_DEFAULT_ALIASES.extractor,
    fallbackModel,
    'memory_extractor',
    'extractor',
  );
  const dreaming = resolveMemoryLlmModelSlot(
    current.llmDreamingModel,
    MEMORY_MODEL_DEFAULT_ALIASES.dreaming,
    fallbackModel,
    'memory_dreaming',
    'dreaming',
  );
  const consolidation = resolveMemoryLlmModelSlot(
    current.llmConsolidationModel,
    MEMORY_MODEL_DEFAULT_ALIASES.consolidation,
    fallbackModel,
    'memory_consolidation',
    'consolidation',
  );
  return {
    extractor: extractor.runnerModel,
    dreaming: dreaming.runnerModel,
    consolidation: consolidation.runnerModel,
    modelProfiles: {
      ...(extractor.modelProfile ? { extractor: extractor.modelProfile } : {}),
      ...(dreaming.modelProfile ? { dreaming: dreaming.modelProfile } : {}),
      ...(consolidation.modelProfile
        ? { consolidation: consolidation.modelProfile }
        : {}),
    },
  };
}
