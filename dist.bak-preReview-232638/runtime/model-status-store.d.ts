import type { ModelCatalogEntry, NormalizedModelUsage, RuntimeContextUsageSnapshot } from '../shared/model-catalog.js';
export interface RuntimeModelStatusSnapshot {
    scopeKey: string;
    threadId?: string | null;
    selectionSource: string;
    modelAlias?: string;
    model?: ModelCatalogEntry;
    contextUsage?: RuntimeContextUsageSnapshot;
    lastUsage?: NormalizedModelUsage;
    cumulativeUsage: NormalizedModelUsage;
}
export interface RuntimeModelStatusSelectionUpdate {
    selectionSource: string;
    modelAlias?: string;
    model?: ModelCatalogEntry;
    contextUsage?: RuntimeContextUsageSnapshot;
}
export declare function updateRuntimeModelStatus(input: {
    scopeKey: string;
    threadId?: string | null;
    selectionSource: string;
    modelAlias?: string;
    model?: ModelCatalogEntry;
    contextUsage?: RuntimeContextUsageSnapshot;
    usage?: NormalizedModelUsage;
    usageKey?: string;
}): void;
export declare function getRuntimeModelStatus(input: {
    scopeKey: string;
    threadId?: string | null;
}): RuntimeModelStatusSnapshot | undefined;
export declare function createRuntimeModelStatusAccess(scopeKey: string, threadId?: string | null): {
    getStatus: () => RuntimeModelStatusSnapshot | undefined;
    updateSelection: (input: RuntimeModelStatusSelectionUpdate) => void;
};
