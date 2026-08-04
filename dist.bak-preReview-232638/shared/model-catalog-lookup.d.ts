import type { ModelCatalogEntry, ModelWorkload } from './model-catalog.js';
export interface ModelCatalogIndexes {
    aliasIndex: Map<string, {
        entry: ModelCatalogEntry;
        alias: string;
    }>;
    idIndex: Map<string, ModelCatalogEntry>;
    exactRunnerModelIndex: Map<string, ModelCatalogEntry>;
    runnerModelIndex: Map<string, ModelCatalogEntry>;
    rawProviderModelIds: Set<string>;
}
export declare function normalizeModelLookupKey(value: string): string;
export declare function createModelCatalogIndexes(entries: readonly ModelCatalogEntry[]): ModelCatalogIndexes;
export declare function suggestModelAlias(input: string, aliasIndex: ModelCatalogIndexes['aliasIndex']): string | undefined;
export declare function modelWorkloadLabel(workload: ModelWorkload): string;
