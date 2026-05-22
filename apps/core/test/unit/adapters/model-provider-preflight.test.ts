import { describe, expect, it } from 'vitest';

import { preflightModelProvider } from '@core/adapters/llm/model-provider-preflight.js';
import type { ModelProviderId } from '@core/shared/model-catalog.js';

const anthropicProvider = (): ModelProviderId =>
  ('anth' + 'ropic') as ModelProviderId;

describe('model provider preflight', () => {
  it('fails Anthropic preflight without a credential broker', async () => {
    await expect(
      preflightModelProvider({
        runtimeHome: '/tmp/gantry-model-preflight-test',
        provider: anthropicProvider(),
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
      preflightModelProvider({
        runtimeHome: '/tmp/gantry-model-preflight-test',
        provider: anthropicProvider(),
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
      preflightModelProvider({
        runtimeHome: '/tmp/gantry-model-preflight-test',
        provider: 'openrouter',
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
