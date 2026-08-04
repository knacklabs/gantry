import { type ModelCatalogEntry } from '../shared/model-catalog.js';
export interface ModelStatusSelectionUpdate {
    selectionSource: string;
    modelAlias?: string;
    model?: ModelCatalogEntry;
}
export declare function defaultModelStatusSelection(defaultModel: string | undefined): ModelStatusSelectionUpdate;
