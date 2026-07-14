export interface RuntimeMemorySettingsSnapshot {
  enabled?: boolean;
  embeddingsEnabled?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  dailyEmbedLimit?: number;
  embedBatchSize?: number;
  backfillEnabled?: boolean;
  backfillCron?: string;
  backfillMaxItemsPerRun?: number;
  backfillMode?: string;
  backfillProviderBatchMinItems?: number;
  dreamingEnabled?: boolean;
  dreamingCron?: string;
  dreamingAlerts?: boolean;
  dreamingEmbeddingsEnabled?: boolean;
  dreamingEmbeddingProvider?: string;
  dreamingEmbeddingModel?: string;
  llmExtractorModel?: string;
  llmDreamingModel?: string;
  llmConsolidationModel?: string;
  extractorMaxFacts?: number;
  extractorMinConfidence?: number;
  maintenanceMaxPending?: number;
}

export interface RuntimeStorageSettingsSnapshot {
  postgresUrlEnv?: string;
  postgresSchema?: string;
}

function parseOptionalBoolean(
  value: unknown,
  pathPrefix: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${pathPrefix} must be true or false`);
  }
  return value;
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseOptionalPositiveInteger(
  value: unknown,
  pathPrefix: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${pathPrefix} must be a positive integer`);
  }
  return value;
}

function parseOptionalNonNegativeInteger(
  value: unknown,
  pathPrefix: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${pathPrefix} must be a non-negative integer`);
  }
  return value;
}

function parseOptionalConfidence(
  value: unknown,
  pathPrefix: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${pathPrefix} must be a number between 0 and 1`);
  }
  return parsed;
}

function parseOptionalPostgresSchema(value: unknown): string | undefined {
  const schema = parseOptionalString(value);
  if (schema === undefined) return undefined;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error(
      'storage.postgres.schema must be a lowercase PostgreSQL schema identifier',
    );
  }
  return schema;
}

export function parseRuntimeMemorySnapshotFromRoot(
  root: Record<string, unknown>,
): RuntimeMemorySettingsSnapshot {
  const memoryRaw = root.memory;
  if (memoryRaw === undefined) return {};
  if (
    typeof memoryRaw !== 'object' ||
    memoryRaw === null ||
    Array.isArray(memoryRaw)
  ) {
    throw new Error('memory must be a mapping');
  }

  const memory = memoryRaw as Record<string, unknown>;
  const embeddingsRaw = memory.embeddings;
  if (
    embeddingsRaw !== undefined &&
    (typeof embeddingsRaw !== 'object' ||
      embeddingsRaw === null ||
      Array.isArray(embeddingsRaw))
  ) {
    throw new Error('memory.embeddings must be a mapping');
  }
  const embeddings = (embeddingsRaw || {}) as Record<string, unknown>;
  const embeddingProvider = parseOptionalString(embeddings.provider);
  if (
    embeddingProvider !== undefined &&
    !/^[a-z][a-z0-9_-]{0,62}$/.test(embeddingProvider)
  ) {
    throw new Error(
      'memory.embeddings.provider must be a lowercase provider id such as disabled or openai',
    );
  }
  const backfillRaw = embeddings.backfill;
  if (
    backfillRaw !== undefined &&
    (typeof backfillRaw !== 'object' ||
      backfillRaw === null ||
      Array.isArray(backfillRaw))
  ) {
    throw new Error('memory.embeddings.backfill must be a mapping');
  }
  const backfill = (backfillRaw || {}) as Record<string, unknown>;
  const backfillMode = parseOptionalString(backfill.mode);
  if (
    backfillMode !== undefined &&
    !['auto', 'inline', 'provider_batch'].includes(backfillMode)
  ) {
    throw new Error(
      'memory.embeddings.backfill.mode must be one of auto, inline, or provider_batch',
    );
  }

  const dreamingRaw = memory.dreaming;
  if (
    dreamingRaw !== undefined &&
    (typeof dreamingRaw !== 'object' ||
      dreamingRaw === null ||
      Array.isArray(dreamingRaw))
  ) {
    throw new Error('memory.dreaming must be a mapping');
  }
  const dreaming = (dreamingRaw || {}) as Record<string, unknown>;
  const dreamingEmbeddingsRaw = dreaming.embeddings;
  if (
    dreamingEmbeddingsRaw !== undefined &&
    (typeof dreamingEmbeddingsRaw !== 'object' ||
      dreamingEmbeddingsRaw === null ||
      Array.isArray(dreamingEmbeddingsRaw))
  ) {
    throw new Error('memory.dreaming.embeddings must be a mapping');
  }
  const dreamingEmbeddings = (dreamingEmbeddingsRaw || {}) as Record<
    string,
    unknown
  >;
  const dreamingEmbeddingProvider = parseOptionalString(
    dreamingEmbeddings.provider,
  );
  if (
    dreamingEmbeddingProvider !== undefined &&
    !/^[a-z][a-z0-9_-]{0,62}$/.test(dreamingEmbeddingProvider)
  ) {
    throw new Error(
      'memory.dreaming.embeddings.provider must be a lowercase provider id such as disabled or openai',
    );
  }

  const maintenanceRaw = memory.maintenance;
  if (
    maintenanceRaw !== undefined &&
    (typeof maintenanceRaw !== 'object' ||
      maintenanceRaw === null ||
      Array.isArray(maintenanceRaw))
  ) {
    throw new Error('memory.maintenance must be a mapping');
  }
  const maintenance = (maintenanceRaw || {}) as Record<string, unknown>;

  const llmRaw = memory.llm;
  if (
    llmRaw !== undefined &&
    (typeof llmRaw !== 'object' || llmRaw === null || Array.isArray(llmRaw))
  ) {
    throw new Error('memory.llm must be a mapping');
  }
  const llm = (llmRaw || {}) as Record<string, unknown>;
  const llmModelsRaw = llm.models;
  if (
    llmModelsRaw !== undefined &&
    (typeof llmModelsRaw !== 'object' ||
      llmModelsRaw === null ||
      Array.isArray(llmModelsRaw))
  ) {
    throw new Error('memory.llm.models must be a mapping');
  }
  const llmModels = (llmModelsRaw || {}) as Record<string, unknown>;

  return {
    enabled: parseOptionalBoolean(memory.enabled, 'memory.enabled'),
    embeddingsEnabled: parseOptionalBoolean(
      embeddings.enabled,
      'memory.embeddings.enabled',
    ),
    embeddingProvider,
    embeddingModel: parseOptionalString(embeddings.model),
    embeddingDimensions: parseOptionalPositiveInteger(
      embeddings.dimensions,
      'memory.embeddings.dimensions',
    ),
    dailyEmbedLimit: parseOptionalNonNegativeInteger(
      embeddings.daily_limit,
      'memory.embeddings.daily_limit',
    ),
    embedBatchSize: parseOptionalPositiveInteger(
      embeddings.batch_size,
      'memory.embeddings.batch_size',
    ),
    backfillEnabled: parseOptionalBoolean(
      backfill.enabled,
      'memory.embeddings.backfill.enabled',
    ),
    backfillCron: parseOptionalString(backfill.cron),
    backfillMaxItemsPerRun: parseOptionalPositiveInteger(
      backfill.max_items_per_run,
      'memory.embeddings.backfill.max_items_per_run',
    ),
    backfillMode,
    backfillProviderBatchMinItems: parseOptionalPositiveInteger(
      backfill.provider_batch_min_items,
      'memory.embeddings.backfill.provider_batch_min_items',
    ),
    dreamingEnabled: parseOptionalBoolean(
      dreaming.enabled,
      'memory.dreaming.enabled',
    ),
    dreamingCron: parseOptionalString(dreaming.cron),
    dreamingAlerts: parseOptionalBoolean(
      dreaming.alerts,
      'memory.dreaming.alerts',
    ),
    dreamingEmbeddingsEnabled: parseOptionalBoolean(
      dreamingEmbeddings.enabled,
      'memory.dreaming.embeddings.enabled',
    ),
    dreamingEmbeddingProvider,
    dreamingEmbeddingModel: parseOptionalString(dreamingEmbeddings.model),
    llmExtractorModel: parseOptionalString(llmModels.extractor),
    llmDreamingModel: parseOptionalString(llmModels.dreaming),
    llmConsolidationModel: parseOptionalString(llmModels.consolidation),
    extractorMaxFacts: parseOptionalPositiveInteger(
      llm.extractor_max_facts,
      'memory.llm.extractor_max_facts',
    ),
    extractorMinConfidence: parseOptionalConfidence(
      llm.extractor_min_confidence,
      'memory.llm.extractor_min_confidence',
    ),
    maintenanceMaxPending: parseOptionalPositiveInteger(
      maintenance.max_pending,
      'memory.maintenance.max_pending',
    ),
  };
}

export function parseRuntimeStorageSnapshotFromRoot(
  root: Record<string, unknown>,
): RuntimeStorageSettingsSnapshot {
  const storageRaw = root.storage;
  if (storageRaw === undefined) return {};
  if (
    typeof storageRaw !== 'object' ||
    storageRaw === null ||
    Array.isArray(storageRaw)
  ) {
    throw new Error('storage must be a mapping');
  }

  const storage = storageRaw as Record<string, unknown>;
  for (const key of Object.keys(storage)) {
    if (key !== 'postgres') {
      throw new Error(
        `storage.${key} is not supported. Configure storage.postgres.*.`,
      );
    }
  }

  const postgresRaw = storage.postgres;
  if (
    postgresRaw !== undefined &&
    (typeof postgresRaw !== 'object' ||
      postgresRaw === null ||
      Array.isArray(postgresRaw))
  ) {
    throw new Error('storage.postgres must be a mapping');
  }
  const postgres = (postgresRaw || {}) as Record<string, unknown>;

  return {
    postgresUrlEnv: parseOptionalString(postgres.url_env),
    postgresSchema: parseOptionalPostgresSchema(postgres.schema),
  };
}
