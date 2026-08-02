import { type ModelRouteProviderId } from './model-provider-registry.js';
import { type ModelProviderAvailability, type ModelProviderRouting } from './model-catalog-provider-metadata.js';
export type ModelResponseFamily = string;
export type ModelRouteId = ModelRouteProviderId;
export type ModelEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelExecutionProviderId = 'anthropic:claude-agent-sdk' | 'deepagents:langchain' | (string & {});
export type ModelWorkload = 'chat' | 'one_time_job' | 'recurring_job' | 'memory_extractor' | 'memory_dreaming' | 'memory_consolidation';
export type ModelCacheMode = 'anthropic-prompt' | 'openai-automatic-prompt' | 'openrouter-provider-prompt' | 'openrouter-response-disabled' | 'none';
export type NormalizedCacheProvider = 'anthropic' | 'openai' | 'openrouter-provider' | 'openrouter-response' | 'mixed' | 'none';
export type NormalizedCacheStatus = 'hit' | 'miss' | 'partial' | 'unsupported' | 'unknown';
export interface ModelCatalogEntry {
    id: string;
    responseFamily: ModelResponseFamily;
    credentialProfileRef: string;
    modelRoute: {
        id: ModelRouteId;
        label: string;
        providerModelId: string;
    };
    displayName: string;
    runnerModel: string;
    aliases: readonly string[];
    recommendedAlias: string;
    source: {
        label: string;
        url: string;
        verifiedAt: string;
    };
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    inputUsdPerMillionTokens?: number;
    outputUsdPerMillionTokens?: number;
    cachedInputUsdPerMillionTokens?: number;
    cacheWriteUsdPerMillionTokens?: number;
    cacheMode: ModelCacheMode;
    cacheTokenFields: readonly string[];
    supportsThinking?: boolean;
    supportsEffort: boolean;
    supportedEffortLevels: readonly ModelEffortLevel[];
    supportsAdaptiveThinking: boolean;
    supportsReasoningEffort: boolean;
    supportsThinkingBudget: boolean;
    supportsTools?: boolean;
    capabilities: ModelCapabilityDescriptor;
    supportedWorkloads: readonly ModelWorkload[];
    providerAvailability?: ModelProviderAvailability;
    providerRouting?: ModelProviderRouting;
    experimental?: boolean;
}
export interface ModelCapabilityDescriptor {
    streaming: boolean;
    toolUse: boolean;
    mcpProjection: boolean;
    browserProjection: boolean;
    sandboxProjection: boolean;
    providerSessionResume: boolean;
    thinking: boolean;
    tokenAccounting: boolean;
    cacheAccounting: boolean;
    structuredOutput: boolean;
}
export interface ModelDefaultAliases {
    chat?: string;
    oneTime?: string;
    recurring?: string;
    memoryExtractor?: string;
    memoryDreaming?: string;
    memoryConsolidation?: string;
}
export interface MemoryModelDefaults {
    extractor: string;
    dreaming: string;
    consolidation: string;
}
export interface NormalizedModelUsage {
    model?: string;
    responseFamily?: ModelResponseFamily;
    modelRoute?: ModelRouteId;
    provider?: ModelRouteId;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalBillableInputTokens: number;
    estimatedCostUsd?: number;
    cacheProvider: NormalizedCacheProvider;
    cacheStatus: NormalizedCacheStatus;
    at: string;
}
export interface RuntimeContextUsageSnapshot {
    totalTokens: number;
    maxTokens: number;
    percentage: number;
    model?: string;
    categories: Array<{
        name: string;
        tokens: number;
        percentage?: number;
    }>;
    apiUsage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
    } | null;
    at: string;
}
export declare const DEFAULT_SETUP_MODEL_ALIAS = "opus";
export declare function providerRoute(providerId: string, providerModelId: string): {
    id: "anthropic" | "openrouter" | "openai" | "bedrock" | "vertex";
    label: string;
    providerModelId: string;
};
export declare function executableModelEntry(input: {
    id: string;
    route: {
        id: ModelRouteId;
        label: string;
        providerModelId: string;
    };
    displayName: string;
    runnerModel: string;
    aliases: readonly string[];
    recommendedAlias: string;
    source: ModelCatalogEntry['source'];
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    inputUsdPerMillionTokens?: number;
    outputUsdPerMillionTokens?: number;
    cachedInputUsdPerMillionTokens?: number;
    cacheWriteUsdPerMillionTokens?: number;
    cacheMode: ModelCacheMode;
    cacheTokenFields: readonly string[];
    supportsThinking?: boolean;
    supportedEffortLevels?: readonly ModelEffortLevel[];
    supportsAdaptiveThinking?: boolean;
    supportsThinkingBudget?: boolean;
    supportsTools?: boolean;
    supportedWorkloads: readonly ModelWorkload[];
    providerAvailability?: ModelProviderAvailability;
    providerRouting?: ModelProviderRouting;
    experimental?: boolean;
}): ModelCatalogEntry;
export type ModelResolution = {
    ok: true;
    entry: ModelCatalogEntry;
    alias: string;
    runnerModel: string;
} | {
    ok: false;
    input: string;
    message: string;
    suggestion?: string;
    reason: 'empty' | 'unknown' | 'raw-provider-id' | 'duplicate-alias' | 'unsupported-workload';
};
export declare const MODEL_CATALOG: readonly ModelCatalogEntry[];
export declare function configureCustomModelCatalogEntries(entries: readonly ModelCatalogEntry[]): void;
export declare function withCustomModelCatalogEntries<T>(entries: readonly ModelCatalogEntry[], fn: () => T): T;
export declare function listModelCatalogEntries(): readonly ModelCatalogEntry[];
export declare function memoryModelDefaultsForProvider(providerId: string): MemoryModelDefaults;
export declare function resolveModelSelection(value?: string | null): ModelResolution;
export declare function resolveModelSelectionForWorkload(value: string | null | undefined, workload: ModelWorkload): ModelResolution;
export declare function resolveModelAlias(value?: string | null): string | undefined;
export declare function resolveRunnerModel(value?: string | null): string | undefined;
export declare function findModelByRunnerModel(value?: string | null): ModelCatalogEntry | undefined;
