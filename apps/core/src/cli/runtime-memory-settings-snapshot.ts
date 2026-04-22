export interface RuntimeMemorySettingsSnapshot {
  enabled?: boolean;
  root?: string;
  embeddingsEnabled?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  dreamingEnabled?: boolean;
  llmExtractorModel?: string;
  llmDreamingModel?: string;
  llmConsolidationModel?: string;
}

export interface RuntimeStorageSettingsSnapshot {
  provider?: 'sqlite' | 'postgres';
  sqlitePath?: string;
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

function parseOptionalPostgresSchema(value: unknown): string | undefined {
  const schema = parseOptionalString(value);
  if (schema === undefined) return undefined;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) {
    throw new Error(
      'storage.postgres.schema must be a valid PostgreSQL schema identifier',
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
  if (!Object.prototype.hasOwnProperty.call(memory, 'root')) {
    throw new Error('memory.root must be set explicitly');
  }
  const rootValue = parseOptionalString(memory.root);
  if (!rootValue) {
    throw new Error('memory.root must be set explicitly');
  }

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
    embeddingProvider !== 'disabled' &&
    embeddingProvider !== 'openai'
  ) {
    throw new Error('memory.embeddings.provider must be disabled or openai');
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
    root: rootValue,
    embeddingsEnabled: parseOptionalBoolean(
      embeddings.enabled,
      'memory.embeddings.enabled',
    ),
    embeddingProvider,
    embeddingModel: parseOptionalString(embeddings.model),
    dreamingEnabled: parseOptionalBoolean(
      dreaming.enabled,
      'memory.dreaming.enabled',
    ),
    llmExtractorModel: parseOptionalString(llmModels.extractor),
    llmDreamingModel: parseOptionalString(llmModels.dreaming),
    llmConsolidationModel: parseOptionalString(llmModels.consolidation),
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
  const sqliteRaw = storage.sqlite;
  if (
    sqliteRaw !== undefined &&
    (typeof sqliteRaw !== 'object' ||
      sqliteRaw === null ||
      Array.isArray(sqliteRaw))
  ) {
    throw new Error('storage.sqlite must be a mapping');
  }
  const sqlite = (sqliteRaw || {}) as Record<string, unknown>;
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

  const providerRaw = parseOptionalString(storage.provider);
  let provider: RuntimeStorageSettingsSnapshot['provider'];
  if (providerRaw !== undefined) {
    if (providerRaw !== 'sqlite' && providerRaw !== 'postgres') {
      throw new Error('storage.provider must be sqlite or postgres');
    }
    provider = providerRaw;
  }

  return {
    provider,
    sqlitePath: parseOptionalString(sqlite.path),
    postgresUrlEnv: parseOptionalString(postgres.url_env),
    postgresSchema: parseOptionalPostgresSchema(postgres.schema),
  };
}
