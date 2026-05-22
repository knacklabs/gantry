import { describe, expect, it } from 'vitest';

import { LlmProfileResolutionService } from '@core/application/model-resolution/llm-profile-resolution-service.js';
import type { LlmProfile } from '@core/domain/agent/agent.js';

function profile(modelAlias: string): LlmProfile {
  return {
    id: 'llm-profile:test' as never,
    appId: 'default' as never,
    purpose: 'chat',
    modelAlias,
    createdAt: '2026-05-22T00:00:00.000Z' as never,
    updatedAt: '2026-05-22T00:00:00.000Z' as never,
  };
}

describe('LlmProfileResolutionService', () => {
  it('resolves an LlmProfile alias to canonical response family and route projection', () => {
    const service = new LlmProfileResolutionService();

    const resolved = service.resolve({
      profile: profile('kimi'),
      workload: 'chat',
    });

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        alias: 'kimi',
        runnerModel: 'moonshotai/kimi-k2.6',
        responseFamily: 'anthropic',
        executionProviderId: 'anthropic:claude-agent-sdk',
        credentialProfileRef: 'gantry-model-access',
        modelRoute: {
          id: 'openrouter',
          label: 'OpenRouter',
          metadata: {
            providerModelId: 'moonshotai/kimi-k2.6',
          },
        },
        capabilities: {
          streaming: true,
          toolUse: true,
          cacheAccounting: true,
        },
      },
    });
  });

  it('rejects raw provider model IDs at the profile boundary', () => {
    const service = new LlmProfileResolutionService();

    expect(
      service.resolve({
        profile: profile('moonshotai/kimi-k2.6'),
        workload: 'chat',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'raw-provider-id',
    });
  });
});
