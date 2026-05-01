import { describe, expect, it } from 'vitest';

import {
  findModelByRunnerModel,
  formatModelCatalog,
  normalizeModelUsage,
  resolveModelSelection,
} from '@core/shared/model-catalog.js';

describe('model catalog resolution', () => {
  it('resolves aliases and catalog IDs to recommended aliases', () => {
    expect(resolveModelSelection(' kimi 2.6 ')).toMatchObject({
      ok: true,
      alias: 'kimi',
      runnerModel: 'moonshotai/kimi-k2.6',
    });

    expect(resolveModelSelection('openrouter:kimi-k2.6')).toMatchObject({
      ok: true,
      alias: 'kimi',
      runnerModel: 'moonshotai/kimi-k2.6',
    });
  });

  it('rejects raw provider model IDs with actionable guidance', () => {
    expect(resolveModelSelection('moonshotai/kimi-k2.6')).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
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
    });

    expect(output).toContain('Supported models');
    expect(output).toContain('chat default');
    expect(output).toContain('one-time default');
    expect(output).toContain('recurring default');
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
      provider: undefined,
      cacheProvider: 'none',
      cacheStatus: 'unsupported',
      totalBillableInputTokens: 8,
    });
  });

  it('returns undefined when usage payload is absent', () => {
    expect(normalizeModelUsage({ message: {}, fallbackModel: 'sonnet' })).toBe(
      undefined,
    );
  });

  it('finds entries by runner ID, provider model ID, and alias', () => {
    expect(findModelByRunnerModel('claude-opus-4-7')?.recommendedAlias).toBe(
      'opus',
    );
    expect(
      findModelByRunnerModel('moonshotai/kimi-k2.6')?.recommendedAlias,
    ).toBe('kimi');
    expect(findModelByRunnerModel('Kimi 2.6')?.recommendedAlias).toBe('kimi');
  });
});
