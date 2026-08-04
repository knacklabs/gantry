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
    cacheMode: ModelCatalogEntry['cacheMode'];
    cacheTokenFields: readonly string[];
    supportedWorkloads: readonly ModelWorkload[];
    providerAvailability?: ModelCatalogEntry['providerAvailability'];
    experimental?: boolean;
}) => ModelCatalogEntry;
export declare function buildBedrockCatalog(deps: {
    executableModelEntry: ExecutableModelEntryFn;
    providerRoute: ProviderRouteFn;
    supportedWorkloads: readonly ModelWorkload[];
}): readonly ModelCatalogEntry[];
export {};
