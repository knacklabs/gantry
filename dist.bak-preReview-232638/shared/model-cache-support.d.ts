import type { ModelCatalogEntry, ModelRouteId, NormalizedCacheProvider } from './model-catalog.js';
import { type ModelProviderCacheSupport } from './model-provider-registry.js';
export interface ModelCacheSupportDescriptor {
    providerId: ModelRouteId;
    providerLabel: string;
    cacheProvider: NormalizedCacheProvider;
    statusLabel: string;
    prompt: ModelProviderCacheSupport['prompt'] & {
        supported: boolean;
        accounted: boolean;
    };
    response: ModelProviderCacheSupport['response'] & {
        available: boolean;
    };
    tokenFields: readonly string[];
}
export declare function resolveModelCacheProvider(entry?: ModelCatalogEntry): NormalizedCacheProvider;
export declare function resolveModelCacheSupport(entry: ModelCatalogEntry): ModelCacheSupportDescriptor;
