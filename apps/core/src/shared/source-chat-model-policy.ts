import type { ModelCatalogEntry } from './model-catalog.js';

/** Catalog compatibility only. Admission still checks application authority and credentials. */
export function sourceChatModelAllowed(
  entry: Pick<
    ModelCatalogEntry,
    'modelRoute' | 'supportedWorkloads' | 'capabilities'
  >,
): boolean {
  // Native source counting currently has direct adapters for these routes only.
  const supportedRoute =
    entry.modelRoute.id === 'openai' || entry.modelRoute.id === 'anthropic';
  return Boolean(
    supportedRoute &&
    entry.supportedWorkloads.includes('chat') &&
    entry.capabilities.toolUse &&
    entry.capabilities.tokenAccounting,
  );
}
