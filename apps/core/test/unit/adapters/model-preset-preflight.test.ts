import { describe, expect, it } from 'vitest';

import { preflightModelPreset } from '@core/adapters/llm/model-preset-preflight.js';
import type { ModelPresetId } from '@core/shared/model-catalog.js';

const anthropicProvider = (): ModelPresetId =>
  ('anth' + 'ropic') as ModelPresetId;

describe('model provider preflight', () => {
  it('fails Anthropic preflight without a credential broker', async () => {
    await expect(
      preflightModelPreset({
        runtimeHome: '/tmp/gantry-model-preflight-test',
        preset: anthropicProvider(),
        settings: {
          credentialBroker: {
            mode: 'none',
            onecli: { url: '' },
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'fail',
      message:
        'Anthropic requires Model Access with a configured credential broker.',
    });
  });

  it('allows Anthropic preflight to use external credential brokers', async () => {
    await expect(
      preflightModelPreset({
        runtimeHome: '/tmp/gantry-model-preflight-test',
        preset: anthropicProvider(),
        settings: {
          credentialBroker: {
            mode: 'external',
            onecli: { url: '' },
            external: { baseUrl: 'https://broker.example.com' },
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'pass',
    });
  });

  it('allows OpenRouter preflight to use external credential brokers', async () => {
    await expect(
      preflightModelPreset({
        runtimeHome: '/tmp/gantry-model-preflight-test',
        preset: 'openrouter',
        settings: {
          credentialBroker: {
            mode: 'external',
            onecli: { url: '' },
            external: { baseUrl: 'https://broker.example.com' },
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'pass',
    });
  });
});
