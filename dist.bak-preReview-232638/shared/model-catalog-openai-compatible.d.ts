import type { ModelCatalogEntry, ModelRouteId, ModelWorkload } from './model-catalog.js';
type ProviderRouteFn = (providerId: string, providerModelId: string) => {
    id: ModelRouteId;
    label: string;
    providerModelId: string;
};
type ExecutableModelEntryFn = (input: {
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
    inputUsdPerMillionTokens?: number;
    outputUsdPerMillionTokens?: number;
    cachedInputUsdPerMillionTokens?: number;
    cacheWriteUsdPerMillionTokens?: number;
    cacheMode: ModelCatalogEntry['cacheMode'];
    cacheTokenFields: readonly string[];
    supportedWorkloads: readonly ModelWorkload[];
    providerAvailability?: ModelCatalogEntry['providerAvailability'];
    providerRouting?: ModelCatalogEntry['providerRouting'];
    experimental?: boolean;
}) => ModelCatalogEntry;
export declare function buildOpenAiCompatibleCatalog(deps: {
    executableModelEntry: ExecutableModelEntryFn;
    providerRoute: ProviderRouteFn;
}): readonly ModelCatalogEntry[];
export {};
