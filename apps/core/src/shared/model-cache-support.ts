import type {
  ModelCatalogEntry,
  ModelRouteId,
  NormalizedCacheProvider,
} from './model-catalog.js';
import {
  getModelProviderDefinition,
  type ModelProviderCacheSupport,
} from './model-provider-registry.js';

export interface ModelCacheSupportDescriptor {
  providerId: ModelRouteId;
  providerLabel: string;
  cacheProvider: NormalizedCacheProvider;
  statusLabel: string;
  prompt: ModelProviderCacheSupport['prompt'] & {
    supported: boolean;
    accounted: boolean;
  };
  response: ModelProviderCacheSupport['response'] & {
    available: boolean;
  };
  tokenFields: readonly string[];
}

export function resolveModelCacheProvider(
  entry?: ModelCatalogEntry,
): NormalizedCacheProvider {
  if (!entry || entry.cacheMode === 'none') return 'none';
  const provider = getModelProviderDefinition(entry.modelRoute.id);
  if (!provider) return 'none';
  switch (entry.cacheMode) {
    case 'anthropic-prompt':
      return provider.cacheSupport.prompt.mode === 'anthropic_cache_control'
        ? 'anthropic'
        : 'none';
    case 'openai-automatic-prompt':
      return provider.cacheSupport.prompt.mode === 'openai_automatic_prefix'
        ? 'openai'
        : 'none';
    case 'openrouter-provider-prompt':
      return provider.cacheSupport.prompt.mode === 'openrouter_automatic_prefix'
        ? 'openrouter-provider'
        : 'none';
    case 'openrouter-response-disabled':
      return provider.cacheSupport.response.mode === 'openrouter_response_cache'
        ? 'openrouter-response'
        : 'none';
  }
}

export function resolveModelCacheSupport(
  entry: ModelCatalogEntry,
): ModelCacheSupportDescriptor {
  const provider = getModelProviderDefinition(entry.modelRoute.id);
  if (!provider) {
    throw new Error(
      `Model catalog entry ${entry.id} references unsupported provider route ${entry.modelRoute.id}.`,
    );
  }
  const cacheProvider = resolveModelCacheProvider(entry);
  const promptSupported =
    cacheProvider === 'anthropic' ||
    cacheProvider === 'openai' ||
    cacheProvider === 'openrouter-provider';
  const responseAvailable = provider.cacheSupport.response.mode !== 'none';
  const responseSuffix =
    responseAvailable && !provider.cacheSupport.response.enabledByDefault
      ? '; response cache available but disabled'
      : '';
  const statusLabel = promptSupported
    ? provider.cacheSupport.prompt.automatic
      ? `automatic provider cache${responseSuffix}`
      : `prompt cache supported/accounted${responseSuffix}`
    : responseAvailable
      ? `response cache available but disabled`
      : 'unsupported';
  return {
    providerId: entry.modelRoute.id,
    providerLabel: entry.modelRoute.label,
    cacheProvider,
    statusLabel,
    prompt: {
      ...provider.cacheSupport.prompt,
      supported: promptSupported,
      accounted: promptSupported && entry.cacheTokenFields.length > 0,
    },
    response: {
      ...provider.cacheSupport.response,
      available: responseAvailable,
    },
    tokenFields: entry.cacheTokenFields,
  };
}
