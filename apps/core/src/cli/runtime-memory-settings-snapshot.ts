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
    embeddingProvider: parseOptionalString(embeddings.provider),
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
