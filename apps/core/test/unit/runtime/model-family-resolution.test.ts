import { describe, expect, it, vi } from 'vitest';

import {
  resolveModelFamilyCandidatesForApp,
  rewriteModelFamilyAliasForApp,
} from '@core/runtime/model-family-resolution.js';

describe('rewriteModelFamilyAliasForApp', () => {
  const lookup = (providers: string[]) => vi.fn(async () => new Set(providers));

  it('passes non-family aliases through unchanged without reading credentials', async () => {
    const listConfiguredProviders = lookup([]);
    const result = await rewriteModelFamilyAliasForApp({
      alias: 'opus',
      appId: 'app-1',
      listConfiguredProviders,
    });
    expect(result).toBe('opus');
    // The credential lookup is skipped entirely for non-family aliases.
    expect(listConfiguredProviders).not.toHaveBeenCalled();
  });

  it('resolves a family alias to the configured provider member (provider A)', async () => {
    const result = await rewriteModelFamilyAliasForApp({
      alias: 'gpt-oss',
      appId: 'app-1',
      listConfiguredProviders: lookup(['groq']),
    });
    expect(result).toBe('groq-oss');
  });

  it('resolves to the second member when only its provider is configured (provider B)', async () => {
    const result = await rewriteModelFamilyAliasForApp({
      alias: 'gpt-oss',
      appId: 'app-1',
      listConfiguredProviders: lookup(['cerebras']),
    });
    expect(result).toBe('cerebras');
  });

  it('falls back to the first member when no provider is configured (loud-failure path)', async () => {
    const result = await rewriteModelFamilyAliasForApp({
      alias: 'gpt-oss',
      appId: 'app-1',
      listConfiguredProviders: lookup([]),
    });
    expect(result).toBe('groq-oss');
  });

  it('resolves llama-70b across its provider preference order', async () => {
    expect(
      await rewriteModelFamilyAliasForApp({
        alias: 'llama-70b',
        appId: 'a',
        listConfiguredProviders: lookup(['together']),
      }),
    ).toBe('together');
    expect(
      await rewriteModelFamilyAliasForApp({
        alias: 'llama-70b',
        appId: 'a',
        listConfiguredProviders: lookup(['groq', 'together']),
      }),
    ).toBe('groq');
  });

  it('honors the settings family-order override', async () => {
    // Override puts cerebras first; both providers configured -> cerebras wins
    // (default order would have picked groq-oss).
    const result = await rewriteModelFamilyAliasForApp({
      alias: 'gpt-oss',
      appId: 'a',
      listConfiguredProviders: lookup(['groq', 'cerebras']),
      familyOrder: { 'gpt-oss': ['cerebras', 'groq-oss'] },
    });
    expect(result).toBe('cerebras');
  });

  it('returns the family alias unchanged when the credential lookup fails', async () => {
    const result = await rewriteModelFamilyAliasForApp({
      alias: 'gpt-oss',
      appId: 'app-1',
      listConfiguredProviders: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    expect(result).toBe('gpt-oss');
  });
});

describe('resolveModelFamilyCandidatesForApp', () => {
  const lookup = (providers: string[]) => vi.fn(async () => new Set(providers));

  it('returns [alias] for a non-family alias without reading credentials', async () => {
    const listConfiguredProviders = lookup([]);
    const result = await resolveModelFamilyCandidatesForApp({
      alias: 'opus',
      appId: 'app-1',
      listConfiguredProviders,
    });
    expect(result).toEqual(['opus']);
    expect(listConfiguredProviders).not.toHaveBeenCalled();
  });

  it('orders configured providers first, then unconfigured last', async () => {
    expect(
      await resolveModelFamilyCandidatesForApp({
        alias: 'gpt-oss',
        appId: 'a',
        listConfiguredProviders: lookup(['cerebras']),
      }),
    ).toEqual(['cerebras', 'groq-oss']);
  });

  it('candidates[0] equals the single-rewrite default', async () => {
    const candidates = await resolveModelFamilyCandidatesForApp({
      alias: 'gpt-oss',
      appId: 'a',
      listConfiguredProviders: lookup(['cerebras']),
    });
    const single = await rewriteModelFamilyAliasForApp({
      alias: 'gpt-oss',
      appId: 'a',
      listConfiguredProviders: lookup(['cerebras']),
    });
    expect(candidates[0]).toBe(single);
  });

  it('falls back to [alias] when the credential lookup fails', async () => {
    const result = await resolveModelFamilyCandidatesForApp({
      alias: 'gpt-oss',
      appId: 'a',
      listConfiguredProviders: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    expect(result).toEqual(['gpt-oss']);
  });
});
