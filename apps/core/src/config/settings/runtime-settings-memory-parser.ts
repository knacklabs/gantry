import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_MEMORY_DREAMING_CRON,
  DEFAULT_MEMORY_EMBED_BATCH_SIZE,
  DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS,
  DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE,
  DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING,
  DEFAULT_OPENAI_DAILY_EMBED_LIMIT,
  getProviderManagedMemoryDefaults,
} from './runtime-settings-defaults.js';
import type {
  EmbeddingProviderName,
  RuntimeMemoryLlmModels,
  RuntimeMemorySettings,
} from './runtime-settings-types.js';

function parseStringValue(
  raw: unknown,
  pathPrefix: string,
  fallback?: string,
): string {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${pathPrefix} must be a non-empty string`);
  }
  return raw.trim();
}

function parseBooleanValue(
  raw: unknown,
  pathPrefix: string,
  fallback?: boolean,
): boolean {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'boolean') {
    throw new Error(`${pathPrefix} must be true/false`);
  }
  return raw;
}

function parsePositiveIntegerValue(
  raw: unknown,
  pathPrefix: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${pathPrefix} must be a positive integer`);
  }
  return raw;
}

function parseNonNegativeIntegerValue(
  raw: unknown,
  pathPrefix: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`${pathPrefix} must be a non-negative integer`);
  }
  return raw;
}

function parseConfidenceValue(
  raw: unknown,
  pathPrefix: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${pathPrefix} must be a number between 0 and 1`);
  }
  return value;
}

function parseEmbeddingProvider(
  raw: unknown,
  pathPrefix: string,
): EmbeddingProviderName {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${pathPrefix} must be a non-empty provider id`);
  }
  const value = raw.trim();
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(value)) {
    throw new Error(
      `${pathPrefix} must be a lowercase provider id such as disabled or openai`,
    );
  }
  return value;
}

function parseMemoryLlmModels(
  raw: unknown,
  pathPrefix: string,
): RuntimeMemoryLlmModels {
  const defaults = getProviderManagedMemoryDefaults();
  if (raw === undefined) return defaults;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  const supportedKeys = new Set(['extractor', 'dreaming', 'consolidation']);
  for (const key of Object.keys(map)) {
    if (!supportedKeys.has(key)) {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Use ${pathPrefix}.extractor, dreaming, or consolidation.`,
      );
    }
  }
  return {
    extractor: parseStringValue(
      map.extractor,
      `${pathPrefix}.extractor`,
      defaults.extractor,
    ),
    dreaming: parseStringValue(
      map.dreaming,
      `${pathPrefix}.dreaming`,
      defaults.dreaming,
    ),
    consolidation: parseStringValue(
      map.consolidation,
      `${pathPrefix}.consolidation`,
      defaults.consolidation,
    ),
  };
}

export function parseMemorySettings(raw: unknown): RuntimeMemorySettings {
  if (raw === undefined) {
    return {
      enabled: true,
      embeddings: {
        enabled: false,
        provider: 'disabled',
        model: DEFAULT_EMBED_MODEL,
        dailyLimit: DEFAULT_OPENAI_DAILY_EMBED_LIMIT,
        batchSize: DEFAULT_MEMORY_EMBED_BATCH_SIZE,
      },
      dreaming: {
        enabled: false,
        cron: DEFAULT_MEMORY_DREAMING_CRON,
        embeddings: {
          enabled: false,
          provider: 'disabled',
          model: DEFAULT_EMBED_MODEL,
        },
      },
      llm: {
        models: getProviderManagedMemoryDefaults(),
        extractorMaxFacts: DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS,
        extractorMinConfidence: DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE,
      },
      maintenance: {
        maxPending: DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING,
      },
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('memory must be a mapping');
  }

  const map = raw as Record<string, unknown>;
  const supportedKeys = new Set([
    'enabled',
    'embeddings',
    'dreaming',
    'llm',
    'maintenance',
  ]);
  for (const key of Object.keys(map)) {
    if (!supportedKeys.has(key)) {
      throw new Error(
        `memory.${key} is not supported. Use memory.enabled/storage.* settings.`,
      );
    }
  }
  const embeddingsRaw = map.embeddings;
  if (
    typeof embeddingsRaw !== 'object' ||
    embeddingsRaw === null ||
    Array.isArray(embeddingsRaw)
  ) {
    throw new Error('memory.embeddings must be a mapping');
  }
  const dreamingRaw = map.dreaming;
  if (
    (dreamingRaw !== undefined && typeof dreamingRaw !== 'object') ||
    dreamingRaw === null ||
    Array.isArray(dreamingRaw)
  ) {
    throw new Error('memory.dreaming must be a mapping');
  }

  const embeddingsMap = embeddingsRaw as Record<string, unknown>;
  const dreamingMap = (dreamingRaw || {}) as Record<string, unknown>;
  const dreamingEmbeddingsRaw = dreamingMap.embeddings;
  if (
    dreamingEmbeddingsRaw !== undefined &&
    (typeof dreamingEmbeddingsRaw !== 'object' ||
      dreamingEmbeddingsRaw === null ||
      Array.isArray(dreamingEmbeddingsRaw))
  ) {
    throw new Error('memory.dreaming.embeddings must be a mapping');
  }
  const dreamingEmbeddingsMap = (dreamingEmbeddingsRaw || {}) as Record<
    string,
    unknown
  >;
  const llmRaw = map.llm;
  if (
    llmRaw !== undefined &&
    (typeof llmRaw !== 'object' || llmRaw === null || Array.isArray(llmRaw))
  ) {
    throw new Error('memory.llm must be a mapping');
  }
  const llmMap = (llmRaw || {}) as Record<string, unknown>;
  const maintenanceRaw = map.maintenance;
  if (
    maintenanceRaw !== undefined &&
    (typeof maintenanceRaw !== 'object' ||
      maintenanceRaw === null ||
      Array.isArray(maintenanceRaw))
  ) {
    throw new Error('memory.maintenance must be a mapping');
  }
  const maintenanceMap = (maintenanceRaw || {}) as Record<string, unknown>;
  const embeddingsKeys = new Set([
    'enabled',
    'provider',
    'model',
    'daily_limit',
    'batch_size',
  ]);
  for (const key of Object.keys(embeddingsMap)) {
    if (!embeddingsKeys.has(key)) {
      throw new Error(
        `memory.embeddings.${key} is not supported. Use memory.embeddings.enabled, provider, or model.`,
      );
    }
  }
  const dreamingKeys = new Set(['enabled', 'cron', 'embeddings']);
  for (const key of Object.keys(dreamingMap)) {
    if (!dreamingKeys.has(key)) {
      throw new Error(
        `memory.dreaming.${key} is not supported. Use memory.dreaming.enabled, cron, or embeddings.`,
      );
    }
  }
  const dreamingEmbeddingsKeys = new Set(['enabled', 'provider', 'model']);
  for (const key of Object.keys(dreamingEmbeddingsMap)) {
    if (!dreamingEmbeddingsKeys.has(key)) {
      throw new Error(
        `memory.dreaming.embeddings.${key} is not supported. Use memory.dreaming.embeddings.enabled, provider, or model.`,
      );
    }
  }
  const llmKeys = new Set([
    'models',
    'extractor_max_facts',
    'extractor_min_confidence',
  ]);
  for (const key of Object.keys(llmMap)) {
    if (!llmKeys.has(key)) {
      throw new Error(
        `memory.llm.${key} is not supported. Use memory.llm.models, extractor_max_facts, or extractor_min_confidence.`,
      );
    }
  }
  const maintenanceKeys = new Set(['max_pending']);
  for (const key of Object.keys(maintenanceMap)) {
    if (!maintenanceKeys.has(key)) {
      throw new Error(
        `memory.maintenance.${key} is not supported. Use memory.maintenance.max_pending.`,
      );
    }
  }
  const enabled = parseBooleanValue(map.enabled, 'memory.enabled');
  const embeddingsEnabled = parseBooleanValue(
    embeddingsMap.enabled,
    'memory.embeddings.enabled',
  );
  const embeddingProvider = parseEmbeddingProvider(
    embeddingsMap.provider,
    'memory.embeddings.provider',
  );
  const dreamingEmbeddingsEnabled = parseBooleanValue(
    dreamingEmbeddingsMap.enabled,
    'memory.dreaming.embeddings.enabled',
    false,
  );
  const dreamingEmbeddingProvider = parseEmbeddingProvider(
    dreamingEmbeddingsMap.provider ?? embeddingProvider,
    'memory.dreaming.embeddings.provider',
  );

  return {
    enabled,
    embeddings: {
      enabled: embeddingsEnabled,
      provider: embeddingsEnabled ? embeddingProvider : 'disabled',
      model: parseStringValue(
        embeddingsMap.model,
        'memory.embeddings.model',
        DEFAULT_EMBED_MODEL,
      ),
      dailyLimit: parseNonNegativeIntegerValue(
        embeddingsMap.daily_limit,
        'memory.embeddings.daily_limit',
        DEFAULT_OPENAI_DAILY_EMBED_LIMIT,
      ),
      batchSize: parsePositiveIntegerValue(
        embeddingsMap.batch_size,
        'memory.embeddings.batch_size',
        DEFAULT_MEMORY_EMBED_BATCH_SIZE,
      ),
    },
    dreaming: {
      enabled: parseBooleanValue(
        dreamingMap.enabled,
        'memory.dreaming.enabled',
        false,
      ),
      cron: parseStringValue(
        dreamingMap.cron,
        'memory.dreaming.cron',
        DEFAULT_MEMORY_DREAMING_CRON,
      ),
      embeddings: {
        enabled: dreamingEmbeddingsEnabled,
        provider: dreamingEmbeddingsEnabled
          ? dreamingEmbeddingProvider
          : 'disabled',
        model: parseStringValue(
          dreamingEmbeddingsMap.model ?? embeddingsMap.model,
          'memory.dreaming.embeddings.model',
          DEFAULT_EMBED_MODEL,
        ),
      },
    },
    llm: {
      models: parseMemoryLlmModels(llmMap.models, 'memory.llm.models'),
      extractorMaxFacts: parsePositiveIntegerValue(
        llmMap.extractor_max_facts,
        'memory.llm.extractor_max_facts',
        DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS,
      ),
      extractorMinConfidence: parseConfidenceValue(
        llmMap.extractor_min_confidence,
        'memory.llm.extractor_min_confidence',
        DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE,
      ),
    },
    maintenance: {
      maxPending: parsePositiveIntegerValue(
        maintenanceMap.max_pending,
        'memory.maintenance.max_pending',
        DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING,
      ),
    },
  };
}
