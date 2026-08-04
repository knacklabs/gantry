import type { ModelCatalogEntry } from './model-catalog.js';
export interface ModelProviderAvailability {
    verifiedAt: string;
    evidence: {
        source: 'official_docs' | 'provider_cli' | 'provider_api';
        commandOrUrl: string;
    };
    scope: {
        kind: 'provider';
    } | {
        kind: 'regions';
        values: readonly string[];
    } | {
        kind: 'locations';
        values: readonly string[];
    };
}
export interface ModelProviderRouting {
    openrouter?: OpenRouterProviderRouting;
}
export interface OpenRouterProviderRouting {
    only?: readonly string[];
    ignore?: readonly string[];
    order?: readonly string[];
    allowFallbacks?: boolean;
    requireParameters?: boolean;
    dataCollection?: 'allow' | 'deny';
    zdr?: boolean;
    enforceDistillableText?: boolean;
    quantizations?: readonly string[];
    sort?: 'price' | 'throughput' | 'latency';
}
export declare function validateModelProviderMetadata(entry: ModelCatalogEntry): void;
