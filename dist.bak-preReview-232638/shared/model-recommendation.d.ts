import type { AgentHarness } from './agent-engine.js';
import { type ModelCatalogEntry, type ModelWorkload } from './model-catalog.js';
export type ModelRecommendationPriority = 'cheap' | 'balanced' | 'best';
export interface ModelRecommendationInput {
    workload: ModelWorkload;
    agentHarness?: AgentHarness;
    configuredProviders?: ReadonlySet<string>;
    estimatedContextTokens?: number;
    requiresTools?: boolean;
    priority?: ModelRecommendationPriority;
    currentAlias?: string | null;
}
export interface ModelRecommendationRejected {
    alias: string;
    reason: string;
}
export interface ModelRecommendation {
    alias: string;
    reason: string;
    entry: ModelCatalogEntry;
    rejected: readonly ModelRecommendationRejected[];
}
export declare function recommendModelAlias(input: ModelRecommendationInput): ModelRecommendation | undefined;
