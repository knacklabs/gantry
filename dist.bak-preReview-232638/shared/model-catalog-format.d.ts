import { type ModelCatalogEntry, type ModelDefaultAliases } from './model-catalog.js';
import { type ModelRecommendationInput } from './model-recommendation.js';
import { type FamilyOrderOverrides } from './model-families.js';
export interface ModelCatalogFormatOptions {
    defaults?: ModelDefaultAliases;
    configuredProviders?: Set<string>;
    familyOrder?: FamilyOrderOverrides;
    recommendation?: ModelRecommendationInput;
}
export declare function formatTokenCount(tokens: number): string;
export declare function formatContextWindow(tokens: number | undefined): string;
export declare function formatCostPerMillion(entry: ModelCatalogEntry): string;
export declare function formatModelDisplay(entry: ModelCatalogEntry): string;
export declare function formatModelCatalog(options?: ModelCatalogFormatOptions): string;
