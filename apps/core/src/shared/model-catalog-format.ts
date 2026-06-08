import {
  MODEL_CATALOG,
  type ModelCatalogEntry,
  type ModelDefaultAliases,
} from './model-catalog.js';
import { resolveModelCacheSupport } from './model-cache-support.js';

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000) {
    return `${tokens / 1_000}k`;
  }
  return String(tokens);
}

export function formatModelDisplay(entry: ModelCatalogEntry): string {
  const experimental = entry.experimental ? ' experimental' : '';
  return `${entry.displayName} (${entry.modelRoute.label}${experimental})`;
}

export function formatModelCatalog(defaults: ModelDefaultAliases = {}): string {
  const lines = [
    'Supported model aliases',
    'Alias | Model | Response family | Route | Cache | Status',
    '--- | --- | --- | --- | --- | ---',
  ];
  for (const entry of MODEL_CATALOG) {
    const cacheSupport = resolveModelCacheSupport(entry);
    for (const alias of entry.aliases) {
      const badges: string[] = [];
      if (alias === entry.recommendedAlias) badges.push('recommended');
      else badges.push('pinned');
      if (defaults.chat === alias) badges.push('chat default');
      if (defaults.oneTime === alias) badges.push('one-time default');
      if (defaults.recurring === alias) badges.push('recurring default');
      if (defaults.memoryExtractor === alias) badges.push('memory extractor');
      if (defaults.memoryDreaming === alias) badges.push('memory dreaming');
      if (defaults.memoryConsolidation === alias) {
        badges.push('memory consolidation');
      }
      lines.push(
        `${alias} | ${entry.displayName} | ${entry.responseFamily} | ${entry.modelRoute.label} | ${cacheSupport.statusLabel} | ${badges.join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}
