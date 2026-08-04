import { type ModelCatalogEntry } from '../../shared/model-catalog.js';
import type { RuntimeCustomModelAlias } from './runtime-settings-types.js';
export declare function parseModelAliases(raw: unknown): Record<string, RuntimeCustomModelAlias>;
export declare function modelAliasesToCatalogEntries(aliases: Record<string, RuntimeCustomModelAlias>): readonly ModelCatalogEntry[];
