import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  gatewayTokenAllowsPath,
  runtimeEventRunIdFor,
  type GatewayTokenRecord,
} from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway-token.js';
import type { AppId } from '@core/domain/app/app.js';
import {
  isSyntheticRunId,
  SYNTHETIC_RUN_ID_PREFIXES,
} from '@core/domain/events/events.js';
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

describe('runtimeEventRunIdFor synthetic run-id denylist', () => {
  it('passes through every legitimate run-id shape', () => {
    // agent_runs.id has TWO legitimate formats: `agent-run:<uuid>` and a bare
    // uuid. An `agent-run:` allowlist would drop run-scoping for every
    // bare-uuid run, so both must survive.
    expect(runtimeEventRunIdFor(tokenRecord({ runId: 'agent-run:abc' }))).toBe(
      'agent-run:abc',
    );
    expect(
      runtimeEventRunIdFor(
        tokenRecord({ runId: '45462980-895e-4195-b830-fca4f803945f' }),
      ),
    ).toBe('45462980-895e-4195-b830-fca4f803945f');
    expect(
      runtimeEventRunIdFor(tokenRecord({ runId: 'run:credential-audit' })),
    ).toBe('run:credential-audit');
  });

  it('drops synthetic ids that have no agent_runs row', () => {
    expect(
      runtimeEventRunIdFor(tokenRecord({ runId: 'permission-classifier:x' })),
    ).toBeUndefined();
    expect(
      runtimeEventRunIdFor(tokenRecord({ runId: 'memory-query:x' })),
    ).toBeUndefined();
    expect(
      runtimeEventRunIdFor(tokenRecord({ runId: 'credential-run:x' })),
    ).toBeUndefined();
    expect(
      runtimeEventRunIdFor(tokenRecord({ runId: undefined })),
    ).toBeUndefined();
    expect(runtimeEventRunIdFor(tokenRecord({ runId: '' }))).toBeUndefined();
  });
});

describe('SYNTHETIC_RUN_ID_PREFIXES registry', () => {
  // The denylist has silently missed a new synthetic minter twice. Every minter
  // in the runtime must have its prefix registered in the shared constant.
  const minters = [
    ['permission-classifier-llm-client.ts', 'permission-classifier:'],
    ['the per-provider memory-query / chat-batch clients', 'memory-query:'],
    ['agent-spawn-host.ts / spawn-turn-tracker.ts', 'credential-run:'],
  ] as const;

  it.each(minters)('registers the prefix minted by %s', (_minter, prefix) => {
    expect(SYNTHETIC_RUN_ID_PREFIXES).toContain(prefix);
    expect(isSyntheticRunId(`${prefix}${randomUUID()}`)).toBe(true);
  });

  it('does not classify either legitimate run-id format as synthetic', () => {
    expect(isSyntheticRunId(`agent-run:${randomUUID()}`)).toBe(false);
    expect(isSyntheticRunId(randomUUID())).toBe(false);
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
