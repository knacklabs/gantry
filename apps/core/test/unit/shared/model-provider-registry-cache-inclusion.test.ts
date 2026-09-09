import { describe, expect, it } from 'vitest';

import {
  listExecutableModelProviders,
  type ModelProviderDefinition,
} from '@core/shared/model-provider-registry.js';
import { validateModelProviderDefinitions } from '@core/shared/model-provider-registry-cache-inclusion.js';

describe('model provider registry', () => {
  it('every executable route declares both cache-inclusion booleans', () => {
    for (const provider of listExecutableModelProviders()) {
      expect(
        typeof provider.cacheSupport.prompt.cacheReadsIncludedInInput,
        provider.id,
      ).toBe('boolean');
      expect(
        typeof provider.cacheSupport.prompt.cacheWritesIncludedInInput,
        provider.id,
      ).toBe('boolean');
    }
  });

  it('a route missing a cache-inclusion boolean fails validation', () => {
    const provider = listExecutableModelProviders()[0]!;
    const { cacheWritesIncludedInInput: _, ...prompt } =
      provider.cacheSupport.prompt;
    const invalid = {
      ...provider,
      cacheSupport: { ...provider.cacheSupport, prompt },
    } as unknown as ModelProviderDefinition;

    expect(() => validateModelProviderDefinitions([invalid])).toThrow(
      TypeError,
    );
  });
});
