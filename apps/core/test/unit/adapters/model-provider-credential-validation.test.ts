import { describe, expect, it } from 'vitest';

import { validateModelCredentialProjectionForEntry } from '../../../src/adapters/llm/anthropic-claude-agent/model-provider-credential-validation.js';
import { listModelCatalogEntries } from '../../../src/shared/model-catalog.js';
import { getModelProviderDefinition } from '../../../src/shared/model-provider-registry.js';

function entryForProvider(providerId: string) {
  const entry = listModelCatalogEntries().find(
    (candidate) => candidate.modelRoute.id === providerId,
  );
  if (!entry) throw new Error(`no catalog entry for ${providerId}`);
  return entry;
}

function projectionEnvNames(providerId: string) {
  const projection =
    getModelProviderDefinition(providerId)?.gateway.sdkProjection;
  if (!projection) throw new Error(`no projection for ${providerId}`);
  return { baseUrlEnv: projection.baseUrlEnv, tokenEnv: projection.tokenEnv };
}

function gatewayProjection(env: Record<string, string>) {
  return {
    env,
    credentialProviders: [],
    brokerProfile: 'gantry',
  };
}

describe('validateModelCredentialProjectionForEntry', () => {
  it('accepts projections using each provider-declared env pair', () => {
    for (const providerId of ['anthropic', 'openai', 'openrouter', 'groq']) {
      const { baseUrlEnv, tokenEnv } = projectionEnvNames(providerId);
      expect(() =>
        validateModelCredentialProjectionForEntry({
          model: entryForProvider(providerId),
          projection: gatewayProjection({
            [baseUrlEnv]: 'http://127.0.0.1:8787',
            [tokenEnv]: 'gtw_test',
          }),
        }),
      ).not.toThrow();
    }
  });

  it('rejects a projection using another provider env pair', () => {
    const anthropic = projectionEnvNames('anthropic');
    const openai = projectionEnvNames('openai');
    expect(anthropic.baseUrlEnv).not.toBe(openai.baseUrlEnv);
    expect(() =>
      validateModelCredentialProjectionForEntry({
        model: entryForProvider('openai'),
        projection: gatewayProjection({
          [anthropic.baseUrlEnv]: 'http://127.0.0.1:8787',
          [anthropic.tokenEnv]: 'gtw_test',
        }),
      }),
    ).toThrow(new RegExp(`loopback ${openai.baseUrlEnv}`));
  });

  it('rejects non-gateway tokens', () => {
    const { baseUrlEnv, tokenEnv } = projectionEnvNames('anthropic');
    expect(() =>
      validateModelCredentialProjectionForEntry({
        model: entryForProvider('anthropic'),
        projection: gatewayProjection({
          [baseUrlEnv]: 'http://127.0.0.1:8787',
          [tokenEnv]: 'sk-real-provider-key',
        }),
      }),
    ).toThrow(/run-scoped gateway token/);
  });
});
