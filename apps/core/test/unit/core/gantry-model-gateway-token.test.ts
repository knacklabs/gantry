import { describe, expect, it } from 'vitest';

import {
  gatewayTokenAllowsPath,
  type GatewayTokenRecord,
} from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway-token.js';
import type { AppId } from '@core/domain/app/app.js';
import { getModelProviderDefinition } from '@core/shared/model-provider-registry.js';

const openAi = getModelProviderDefinition('openai')!;

describe('gateway batch token file scope', () => {
  it('allows only file content associated with the token batch', () => {
    const token = tokenRecord({
      purpose: 'model_batch',
      modelBatchId: 'batch_own',
      modelBatchFileIds: new Map([['file_own', 'batch_own']]),
    });

    expect(
      gatewayTokenAllowsPath(
        token,
        openAi,
        '/v1/files/file_own/content',
        'GET',
      ),
    ).toBe(true);
    expect(
      gatewayTokenAllowsPath(
        token,
        openAi,
        '/v1/files/file_foreign/content',
        'GET',
      ),
    ).toBe(false);
  });

  it('fails closed for an unbound batch token and preserves regular-token policy', () => {
    const unboundBatch = tokenRecord({ purpose: 'model_batch' });
    const regular = tokenRecord({ purpose: 'model_runtime' });

    expect(
      gatewayTokenAllowsPath(
        unboundBatch,
        openAi,
        '/v1/files/file_unknown/content',
        'GET',
      ),
    ).toBe(false);
    expect(
      gatewayTokenAllowsPath(regular, openAi, '/v1/chat/completions', 'POST'),
    ).toBe(true);
    expect(
      gatewayTokenAllowsPath(
        regular,
        openAi,
        '/v1/files/file_unknown/content',
        'GET',
      ),
    ).toBe(false);
  });
});

function tokenRecord(
  overrides: Partial<GatewayTokenRecord>,
): GatewayTokenRecord {
  return {
    token: 'gtw_test',
    appId: 'default' as AppId,
    providerId: 'openai',
    authMode: 'api_key',
    schemaVersion: 1,
    credentialFingerprint: 'fingerprint',
    createdAtMs: 1,
    expiresAtMs: 2,
    tokenScope: 'batch:run:test',
    purpose: 'model_batch',
    modelBatchRequestCount: 1,
    modelBatchUploadedFileIds: new Set(),
    modelBatchFileIds: new Map(),
    ...overrides,
  };
}
