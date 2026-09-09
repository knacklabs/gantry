import { describe, expect, it } from 'vitest';

import { modelVisibleInputTokens } from '@core/shared/model-usage.js';

describe('modelVisibleInputTokens', () => {
  it('sums input, cache read and cache write for an additive Anthropic route', () => {
    expect(
      modelVisibleInputTokens({
        modelRoute: 'anthropic',
        inputTokens: 1_000,
        cacheReadTokens: 270_000,
        cacheWriteTokens: 500,
      }),
    ).toBe(271_500);
  });

  it('uses input alone for an inclusive OpenAI-compatible route with nonzero cache writes', () => {
    for (const modelRoute of ['openai', 'openrouter'] as const) {
      expect(
        modelVisibleInputTokens({
          modelRoute,
          inputTokens: 1_000,
          cacheReadTokens: 800,
          cacheWriteTokens: 500,
        }),
      ).toBe(1_000);
    }
  });

  it('uses the additive form for a mixed or unresolved route', () => {
    for (const modelRoute of [undefined, 'unknown'] as const) {
      expect(
        modelVisibleInputTokens({
          modelRoute,
          inputTokens: 1_000,
          cacheReadTokens: 800,
          cacheWriteTokens: 500,
        }),
      ).toBe(2_300);
    }
  });
});
