import type { ModelCatalogEntry } from './model-catalog.js';
import { getModelProviderDefinition } from './model-provider-registry.js';

/** Catalog compatibility only. Admission still checks application authority and credentials. */
export function sourceChatModelAllowed(
  entry: Pick<
    ModelCatalogEntry,
    'modelRoute' | 'supportedWorkloads' | 'capabilities'
  >,
): boolean {
  const provider = getModelProviderDefinition(entry.modelRoute.id);
  return Boolean(
    provider &&
    entry.supportedWorkloads.includes('chat') &&
    entry.capabilities.toolUse &&
    entry.capabilities.tokenAccounting &&
    (provider.responseFamily === 'anthropic' ||
      provider.responseFamily === 'openai'),
  );
}
