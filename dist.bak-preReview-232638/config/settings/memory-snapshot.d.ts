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
export declare function parseRuntimeMemorySnapshotFromRoot(root: Record<string, unknown>): RuntimeMemorySettingsSnapshot;
export declare function parseRuntimeStorageSnapshotFromRoot(root: Record<string, unknown>): RuntimeStorageSettingsSnapshot;
