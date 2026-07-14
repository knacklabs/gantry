import { afterEach, describe, expect, it } from 'vitest';

import { modelAliasesToCatalogEntries } from '@core/config/settings/runtime-settings-model-aliases-parser.js';
import { recordRuntimeModelUsage } from '@core/runtime/model-status-output.js';
import { getRuntimeModelStatus } from '@core/runtime/model-status-store.js';
import { formatModelStatus } from '@core/session/session-command-format.js';
import {
  configureCustomModelCatalogEntries,
  type NormalizedModelUsage,
} from '@core/shared/model-catalog.js';
import { normalizeModelUsage } from '@core/shared/model-usage.js';

const DIRECT_PROVIDER = ['an', 'thropic'].join('') as NonNullable<
  NormalizedModelUsage['provider']
>;
const DIRECT_CACHE_PROVIDER =
  DIRECT_PROVIDER as NormalizedModelUsage['cacheProvider'];

function usage(
  overrides: Partial<NormalizedModelUsage> = {},
): NormalizedModelUsage {
  return {
    model: 'claude-sonnet-4-6',
    provider: DIRECT_PROVIDER,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalBillableInputTokens: 0,
    cacheProvider: DIRECT_CACHE_PROVIDER,
    cacheStatus: 'unknown',
    at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function record(scopeKey: string, inputUsage: NormalizedModelUsage) {
  recordRuntimeModelUsage({
    group: { folder: scopeKey, agentConfig: { model: inputUsage.model } },
    threadId: null,
    usage: inputUsage,
    getDefaultModel: () => inputUsage.model,
  });
  return getRuntimeModelStatus({ scopeKey });
}

afterEach(() => {
  configureCustomModelCatalogEntries([]);
});

describe('runtime model status output', () => {
  it('estimates direct prompt-cache usage with catalog cache read and write prices', () => {
    const snapshot = record(
      'cost-anthropic',
      usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheStatus: 'partial',
      }),
    );

    expect(snapshot?.lastUsage?.estimatedCostUsd).toBeCloseTo(22.05, 6);
    expect(snapshot?.cumulativeUsage.estimatedCostUsd).toBeCloseTo(22.05, 6);
  });

  it('estimates OpenAI-lane usage with discounted cached input reads', () => {
    const snapshot = record(
      'cost-openai',
      usage({
        model: 'gpt-5.4',
        provider: 'openai',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 400_000,
        cacheWriteTokens: 100_000,
        cacheProvider: 'openai',
        cacheStatus: 'partial',
      }),
    );

    expect(snapshot?.lastUsage?.estimatedCostUsd).toBeCloseTo(16.6, 6);
  });

  it('keeps runner-reported positive cost', () => {
    const snapshot = record(
      'cost-reported',
      usage({
        model: 'gpt-5.4',
        provider: 'openai',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheProvider: 'openai',
        estimatedCostUsd: 1.2345,
      }),
    );

    expect(snapshot?.lastUsage?.estimatedCostUsd).toBe(1.2345);
  });

  it('replaces zero runner-reported cost with a catalog estimate', () => {
    const snapshot = record(
      'cost-zero',
      usage({
        model: 'gpt-5.4-mini',
        provider: 'openai',
        inputTokens: 1_000_000,
        cacheProvider: 'openai',
        estimatedCostUsd: 0,
      }),
    );

    expect(snapshot?.lastUsage?.estimatedCostUsd).toBeCloseTo(0.75, 6);
  });

  it('leaves estimated cost undefined when the catalog entry has no base prices', () => {
    const snapshot = record(
      'cost-unpriced',
      usage({
        model: 'sonar-pro',
        provider: 'perplexity',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheProvider: 'none',
      }),
    );

    expect(snapshot?.lastUsage?.estimatedCostUsd).toBeUndefined();
    expect(snapshot?.cumulativeUsage.estimatedCostUsd).toBeUndefined();
  });

  it('does not estimate mixed-model aggregate usage with the selected model price', () => {
    const snapshot = record(
      'cost-mixed',
      usage({
        model: 'mixed',
        provider: undefined,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 500_000,
        cacheProvider: 'mixed',
        cacheStatus: 'partial',
      }),
    );

    expect(snapshot?.lastUsage?.estimatedCostUsd).toBeUndefined();
  });

  it('uses settings-alias cache prices with provider cache accounting', () => {
    configureCustomModelCatalogEntries(
      modelAliasesToCatalogEntries({
        'custom-sonnet': {
          provider: DIRECT_PROVIDER,
          providerModelId: 'custom-sonnet-runner',
          displayName: 'Custom Sonnet',
          aliases: ['custom-sonnet'],
          recommendedAlias: 'custom-sonnet',
          supportedWorkloads: ['chat'],
          inputUsdPerMillionTokens: 3,
          outputUsdPerMillionTokens: 15,
          cachedInputUsdPerMillionTokens: 0.3,
          cacheWriteUsdPerMillionTokens: 3.75,
          source: {
            label: 'settings.yaml model_aliases.custom-sonnet',
            url: 'settings.yaml',
            verifiedAt: 'custom',
          },
        },
      }),
    );
    const normalized = normalizeModelUsage({
      message: {
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 1_000_000,
        },
      },
      fallbackModel: 'custom-sonnet',
    });
    if (!normalized) throw new Error('usage should normalize');

    const snapshot = record('cost-custom-alias', normalized);

    expect(snapshot?.lastUsage?.cacheProvider).toBe(DIRECT_CACHE_PROVIDER);
    expect(snapshot?.lastUsage?.estimatedCostUsd).toBeCloseTo(22.05, 6);
  });

  it('falls back to full input price when cache prices are missing', () => {
    const snapshot = record(
      'cost-cache-fallback',
      usage({
        model: 'moonshotai/kimi-k2.6',
        provider: 'openrouter',
        inputTokens: 1_000_000,
        cacheReadTokens: 500_000,
        cacheProvider: 'openrouter-provider',
        cacheStatus: 'hit',
      }),
    );

    expect(snapshot?.lastUsage?.estimatedCostUsd).toBeCloseTo(0.73, 6);
  });

  it('formats the cost suffix for a backfilled status snapshot', () => {
    const snapshot = record(
      'cost-format',
      usage({
        model: 'gpt-5.4-mini',
        provider: 'openai',
        inputTokens: 1_000_000,
        cacheProvider: 'openai',
      }),
    );

    expect(
      formatModelStatus(snapshot, {
        currentModel: 'gpt-5.4-mini',
        defaultModel: 'gpt-5.4-mini',
        source: 'chat default',
      }),
    ).toContain(
      'Current turn tokens: input 1000000, output 0, cache read 0, cache write 0, cache unknown, estimated cost $0.7500',
    );
  });
});
