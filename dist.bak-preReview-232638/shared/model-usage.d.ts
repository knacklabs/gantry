import { type ModelCatalogEntry, type NormalizedModelUsage } from './model-catalog.js';
export declare function estimateUsageCostUsd(entry: ModelCatalogEntry | undefined, usage: Pick<NormalizedModelUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheProvider'>): number | undefined;
export declare function accumulateModelUsage(accumulated: NormalizedModelUsage | undefined, usage: NormalizedModelUsage): NormalizedModelUsage;
export declare function normalizeModelUsage(input: {
    message: unknown;
    fallbackModel?: string;
}): NormalizedModelUsage | undefined;
