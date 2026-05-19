import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfiguredModel } from '@core/adapters/llm/anthropic-claude-agent/runner/model-config.js';

const previousModel = process.env.ANTHROPIC_MODEL;

afterEach(() => {
  if (previousModel === undefined) {
    delete process.env.ANTHROPIC_MODEL;
  } else {
    process.env.ANTHROPIC_MODEL = previousModel;
  }
});

describe('Claude runner model config', () => {
  it('accepts parent-owned catalog runner model ids from ANTHROPIC_MODEL', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    expect(resolveConfiguredModel()).toEqual({
      model: 'claude-opus-4-7',
      source: 'ANTHROPIC_MODEL',
    });

    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    expect(resolveConfiguredModel()).toEqual({
      model: 'claude-sonnet-4-6',
      source: 'ANTHROPIC_MODEL',
    });

    process.env.ANTHROPIC_MODEL = 'moonshotai/kimi-k2.6';
    expect(resolveConfiguredModel()).toEqual({
      model: 'moonshotai/kimi-k2.6',
      source: 'ANTHROPIC_MODEL',
    });
  });

  it('still ignores unknown model ids from ANTHROPIC_MODEL', () => {
    process.env.ANTHROPIC_MODEL = 'custom-provider-model';

    expect(resolveConfiguredModel()).toEqual({ source: 'unset' });
  });
});
