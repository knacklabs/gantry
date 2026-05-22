import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfiguredModel } from '@core/adapters/llm/anthropic-claude-agent/runner/model-config.js';

const previousModel = process.env.ANTHROPIC_MODEL;
const previousSource = process.env.GANTRY_EFFECTIVE_MODEL_SOURCE;

afterEach(() => {
  if (previousModel === undefined) {
    delete process.env.ANTHROPIC_MODEL;
  } else {
    process.env.ANTHROPIC_MODEL = previousModel;
  }
  if (previousSource === undefined) {
    delete process.env.GANTRY_EFFECTIVE_MODEL_SOURCE;
  } else {
    process.env.GANTRY_EFFECTIVE_MODEL_SOURCE = previousSource;
  }
});

describe('Claude runner model config', () => {
  it('accepts parent-owned catalog runner model ids from ANTHROPIC_MODEL', () => {
    process.env.GANTRY_EFFECTIVE_MODEL_SOURCE = 'runtime';
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

  it('ignores raw provider IDs when they are not parent-owned runtime selections', () => {
    process.env['ANTHROPIC' + '_MODEL'] = 'claude-sonnet-4-6';
    delete process.env.GANTRY_EFFECTIVE_MODEL_SOURCE;

    expect(resolveConfiguredModel()).toEqual({ source: 'unset' });
  });

  it('accepts aliases from the model environment lane', () => {
    process.env['ANTHROPIC' + '_MODEL'] = 'sonnet';

    expect(resolveConfiguredModel()).toEqual({
      model: 'claude-sonnet-4-6',
      source: 'ANTHROPIC' + '_MODEL',
    });
  });

  it('still ignores unknown model ids from ANTHROPIC_MODEL', () => {
    process.env.ANTHROPIC_MODEL = 'custom-provider-model';

    expect(resolveConfiguredModel()).toEqual({ source: 'unset' });
  });
});
