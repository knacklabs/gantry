import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETUP_MODEL_ALIAS,
  findModelByRunnerModel,
  MEMORY_MODEL_DEFAULT_ALIASES,
  resolveModelSelection,
  resolveModelSelectionForWorkload,
  resolveRunnerModel,
} from '@core/shared/model-catalog.js';
import { resolveModelCacheSupport } from '@core/shared/model-cache-support.js';
import { formatModelCatalog } from '@core/shared/model-catalog-format.js';
import { normalizeModelUsage } from '@core/shared/model-usage.js';

describe('model catalog resolution', () => {
  it('keeps versioned aliases pinned while short aliases stay recommended', () => {
    expect(resolveModelSelection(' kimi 2.6 ')).toMatchObject({
      ok: true,
      alias: 'kimi-2.6',
      runnerModel: 'moonshotai/kimi-k2.6',
    });
    expect(resolveModelSelection('kimi')).toMatchObject({
      ok: true,
      alias: 'kimi',
      runnerModel: 'moonshotai/kimi-k2.6',
    });
    expect(resolveModelSelection('Opus 4.8')).toMatchObject({
      ok: true,
      alias: 'opus-4.8',
    });
  });

  it('finds catalog entries by runner or provider model IDs for runtime accounting', () => {
    expect(resolveModelSelection('openrouter:kimi-k2.6')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
    expect(findModelByRunnerModel('moonshotai/kimi-k2.6')).toMatchObject({
      recommendedAlias: 'kimi',
    });
  });

  it('uses catalog aliases for setup and memory defaults', () => {
    expect(DEFAULT_SETUP_MODEL_ALIAS).toBe('opus');
    expect(MEMORY_MODEL_DEFAULT_ALIASES).toEqual({
      extractor: 'haiku',
      dreaming: 'sonnet',
      consolidation: 'sonnet',
    });
  });

  it('resolves catalog aliases without accepting raw runner IDs', () => {
    expect(resolveRunnerModel('opus')).toBe('claude-opus-4-8');
    expect(resolveRunnerModel('opus 4.8')).toBe('claude-opus-4-8');
    expect(resolveRunnerModel('opus 4.7')).toBe('claude-opus-4-7');
    expect(resolveRunnerModel('claude-sonnet-4-6')).toBeUndefined();
    expect(resolveRunnerModel('opusplan')).toBeUndefined();
    expect(resolveRunnerModel('best')).toBeUndefined();
  });

  it('rejects raw provider model IDs from user-facing alias resolution', () => {
    expect(resolveModelSelection('claude-opus-4-7')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
    expect(resolveModelSelection('claude-ambient-model')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
  });

  it('rejects raw provider model IDs with actionable guidance', () => {
    expect(resolveModelSelection('moonshotai/kimi-k2.6')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
  });

  it('enforces workload eligibility for catalog aliases', () => {
    expect(resolveModelSelectionForWorkload('opus', 'chat')).toMatchObject({
      ok: true,
      alias: 'opus',
    });
    expect(
      resolveModelSelectionForWorkload('opus', 'memory_extractor'),
    ).toMatchObject({
      ok: false,
      reason: 'unsupported-workload',
    });
    expect(
      resolveModelSelectionForWorkload('kimi', 'memory_consolidation'),
    ).toMatchObject({
      ok: true,
      alias: 'kimi',
    });
  });

  it('suggests close aliases for typos', () => {
    expect(resolveModelSelection('sonet')).toMatchObject({
      ok: false,
      reason: 'unknown',
      suggestion: 'sonnet',
    });
  });

  it('renders model catalog defaults across chat and scheduler lanes', () => {
    const output = formatModelCatalog({
      chat: 'opus',
      oneTime: 'sonnet',
      recurring: 'kimi',
      memoryExtractor: 'haiku',
      memoryDreaming: 'sonnet',
      memoryConsolidation: 'sonnet',
    });

    expect(output).toContain('Supported model aliases');
    expect(output).toContain('Response family');
    expect(output).toContain('prompt cache supported/accounted');
    expect(output).toContain('chat default');
    expect(output).toContain('one-time default');
    expect(output).toContain('recurring default');
    expect(output).toContain('memory extractor');
    expect(output).toContain('OpenRouter');
  });

  it('derives cache support from provider metadata and model route', () => {
    const anthropic = findModelByRunnerModel('claude-sonnet-4-6');
    const openrouter = findModelByRunnerModel('moonshotai/kimi-k2.6');

    expect(anthropic && resolveModelCacheSupport(anthropic)).toMatchObject({
      providerId: 'anthropic',
      cacheProvider: 'anthropic',
      statusLabel: 'prompt cache supported/accounted',
      prompt: {
        mode: 'anthropic_cache_control',
        supported: true,
        accounted: true,
      },
      response: {
        mode: 'none',
        available: false,
      },
    });
    expect(openrouter && resolveModelCacheSupport(openrouter)).toMatchObject({
      providerId: 'openrouter',
      cacheProvider: 'openrouter-provider',
      statusLabel:
        'prompt cache supported/accounted; response cache available but disabled',
      prompt: {
        mode: 'openrouter_anthropic_cache_control',
        supported: true,
        accounted: true,
      },
      response: {
        mode: 'openrouter_response_cache',
        enabledByDefault: false,
        available: true,
      },
    });
  });
});

describe('model usage normalization', () => {
  it('normalizes Anthropic-style modelUsage payloads and cache accounting', () => {
    const usage = normalizeModelUsage({
      message: {
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 10,
            costUSD: 0.002,
          },
        },
      },
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(usage).toMatchObject({
      model: 'sonnet',
      responseFamily: 'anthropic',
      modelRoute: 'anthropic',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      totalBillableInputTokens: 60,
      estimatedCostUsd: 0.002,
      cacheProvider: 'anthropic',
      cacheStatus: 'partial',
    });
    expect(typeof usage?.at).toBe('string');
  });

  it('does not infer cache support for uncataloged modelUsage entries', () => {
    const usage = normalizeModelUsage({
      message: {
        modelUsage: {
          'future-model': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 10,
          },
        },
      },
    });

    expect(usage).toMatchObject({
      model: 'future-model',
      cacheProvider: 'none',
      cacheStatus: 'unsupported',
    });
  });

  it('marks aggregate modelUsage from multiple models as mixed', () => {
    const usage = normalizeModelUsage({
      message: {
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 10,
            costUSD: 0.002,
          },
          'moonshotai/kimi-k2.6': {
            inputTokens: 50,
            outputTokens: 10,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 0,
            costUSD: 0.001,
          },
        },
      },
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(usage).toMatchObject({
      model: 'mixed',
      responseFamily: 'anthropic',
      modelRoute: undefined,
      provider: undefined,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      estimatedCostUsd: 0.003,
      cacheProvider: 'mixed',
      cacheStatus: 'partial',
    });
  });

  it('normalizes OpenRouter usage payload cache details', () => {
    const usage = normalizeModelUsage({
      message: {
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: {
            cached_tokens: 50,
            cache_write_tokens: 0,
          },
        },
      },
      fallbackModel: 'moonshotai/kimi-k2.6',
    });

    expect(usage).toMatchObject({
      model: 'kimi',
      responseFamily: 'anthropic',
      modelRoute: 'openrouter',
      provider: 'openrouter',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      totalBillableInputTokens: 70,
      cacheProvider: 'openrouter-provider',
      cacheStatus: 'hit',
    });
  });

  it('reads direct Anthropic cache usage fields from provider metadata', () => {
    const usage = normalizeModelUsage({
      message: {
        usage: {
          input_tokens: 200,
          output_tokens: 40,
          cache_read_input_tokens: 75,
          cache_creation_input_tokens: 25,
        },
      },
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(usage).toMatchObject({
      model: 'sonnet',
      modelRoute: 'anthropic',
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 75,
      cacheWriteTokens: 25,
      totalBillableInputTokens: 125,
      cacheProvider: 'anthropic',
      cacheStatus: 'partial',
    });
  });

  it('marks cache as unsupported when provider metadata is unavailable', () => {
    const usage = normalizeModelUsage({
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          prompt_tokens_details: {
            cached_tokens: 2,
          },
        },
      },
      fallbackModel: 'unknown-model',
    });

    expect(usage).toMatchObject({
      model: 'unknown-model',
      responseFamily: undefined,
      modelRoute: undefined,
      provider: undefined,
      cacheProvider: 'none',
      cacheStatus: 'unsupported',
      totalBillableInputTokens: 10,
    });
  });

  it('returns undefined when usage payload is absent', () => {
    expect(normalizeModelUsage({ message: {}, fallbackModel: 'sonnet' })).toBe(
      undefined,
    );
  });

  it('finds entries by runner ID, provider model ID, and alias', () => {
    expect(findModelByRunnerModel('claude-opus-4-8')?.recommendedAlias).toBe(
      'opus',
    );
    expect(findModelByRunnerModel('claude-opus-4-7')?.recommendedAlias).toBe(
      'opus-4.7',
    );
    expect(
      findModelByRunnerModel('moonshotai/kimi-k2.6')?.recommendedAlias,
    ).toBe('kimi');
    expect(findModelByRunnerModel('Kimi 2.6')?.recommendedAlias).toBe('kimi');
  });
});
