import type { ModelProviderDefinition } from './model-provider-registry.js';

export type ModelProviderPromptCacheMode =
  | 'none'
  | 'anthropic_cache_control'
  | 'openai_automatic_prefix'
  | 'openrouter_automatic_prefix';

export interface ModelProviderCacheUsageFields {
  readTokens?: string;
  writeTokens?: string;
  responseHeaders?: readonly string[];
}

export function validateModelProviderDefinitions(
  providers: readonly ModelProviderDefinition[],
): void {
  for (const provider of providers) {
    if (!provider.executable) continue;
    const prompt = provider.cacheSupport.prompt;
    if (
      typeof prompt.cacheReadsIncludedInInput !== 'boolean' ||
      typeof prompt.cacheWritesIncludedInInput !== 'boolean'
    ) {
      throw new TypeError(
        `Model provider ${provider.id} must declare prompt cache input inclusion.`,
      );
    }
  }
}
