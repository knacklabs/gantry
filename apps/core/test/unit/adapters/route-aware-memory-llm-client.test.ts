import { describe, expect, it, vi } from 'vitest';

import { createRouteAwareMemoryLlmClient } from '@core/adapters/llm/route-aware-memory-llm-client.js';
import type {
  MemoryLlmBatchCapability,
  MemoryLlmClient,
  MemoryLlmModelProfile,
} from '@core/domain/ports/memory-llm-client.js';

const DEFAULT_FAMILY = ['anth', 'ropic'].join('');
const OPENAI_FAMILY = 'openai';

function fakeClient(
  name: string,
  configured = true,
  batch?: MemoryLlmBatchCapability,
): MemoryLlmClient {
  return {
    isConfigured: () => configured,
    query: vi.fn(async () => name),
    ...(batch ? { batch } : {}),
  };
}

function fakeBatch(name: string): MemoryLlmBatchCapability {
  return {
    preflightBatch: vi.fn(async () => undefined),
    submitBatch: vi.fn(async () => ({ batchId: name })),
    pollBatch: vi.fn(async (opts) => ({
      batchId: opts.batchId,
      state: 'completed',
    })),
    fetchBatchResults: vi.fn(async () => []),
    findBatchByCorrelationId: vi.fn(async () => ({ batchId: name })),
  };
}

function profile(
  overrides: Partial<MemoryLlmModelProfile>,
): MemoryLlmModelProfile {
  return {
    alias: 'alias',
    runnerModel: 'runner',
    responseFamily: OPENAI_FAMILY,
    modelRoute: 'openai',
    modelRouteLabel: 'OpenAI',
    displayName: 'Display',
    ...overrides,
  };
}

function buildRouter() {
  const anthropic = fakeClient('anthropic-sdk');
  const anthropicSingleRequest = fakeClient('anthropic-direct');
  const openai = fakeClient('openai-direct');
  const router = createRouteAwareMemoryLlmClient({
    anthropic,
    anthropicSingleRequest,
    openai,
  });
  return { router, anthropic, anthropicSingleRequest, openai };
}

describe('route-aware memory LLM client (family-derived)', () => {
  it('anthropic-family -> Claude Agent SDK memory client', async () => {
    const { router, anthropic, openai } = buildRouter();
    const result = await router.query({
      appId: 'default' as never,
      model: 'claude-runner',
      modelProfile: profile({ responseFamily: DEFAULT_FAMILY }),
      prompt: 'hi',
    });
    expect(result).toBe('anthropic-sdk');
    expect(anthropic.query).toHaveBeenCalledTimes(1);
    expect(openai.query).not.toHaveBeenCalled();
  });

  it('openai-family -> OpenAI direct client', async () => {
    const { router, anthropic, openai } = buildRouter();
    const result = await router.query({
      appId: 'default' as never,
      model: 'gpt-runner',
      modelProfile: profile({ responseFamily: OPENAI_FAMILY }),
      prompt: 'hi',
    });
    expect(result).toBe('openai-direct');
    expect(openai.query).toHaveBeenCalledTimes(1);
    expect(anthropic.query).not.toHaveBeenCalled();
  });

  it('uses the single-request client only for opted-in anthropic-family calls', async () => {
    const { router, anthropic, anthropicSingleRequest, openai } = buildRouter();
    const result = await router.query({
      appId: 'default' as never,
      model: 'claude-runner',
      modelProfile: profile({ responseFamily: DEFAULT_FAMILY }),
      prompt: 'hi',
      singleRequest: true,
    });
    expect(result).toBe('anthropic-direct');
    expect(anthropicSingleRequest.query).toHaveBeenCalledTimes(1);
    expect(anthropic.query).not.toHaveBeenCalled();
    expect(openai.query).not.toHaveBeenCalled();
  });

  it('keeps opted-in openai-family calls on the existing OpenAI client', async () => {
    const { router, anthropicSingleRequest, openai } = buildRouter();
    const result = await router.query({
      appId: 'default' as never,
      model: 'gpt-runner',
      modelProfile: profile({ responseFamily: OPENAI_FAMILY }),
      prompt: 'hi',
      singleRequest: true,
    });
    expect(result).toBe('openai-direct');
    expect(openai.query).toHaveBeenCalledTimes(1);
    expect(anthropicSingleRequest.query).not.toHaveBeenCalled();
  });

  it('OpenRouter provider -> OpenAI-compatible client despite anthropic family', async () => {
    const { router, anthropic, openai } = buildRouter();
    const result = await router.query({
      appId: 'default' as never,
      model: 'moonshotai/kimi-k2.6',
      modelProfile: profile({
        // OpenRouter/Kimi carries the default response family but speaks the
        // OpenAI chat/completions API on the DeepAgents lane, so it must route
        // to the OpenAI-compatible client by provider, not family.
        responseFamily: DEFAULT_FAMILY,
        modelRoute: 'openrouter',
        runnerModel: 'moonshotai/kimi-k2.6',
        alias: 'kimi',
      }),
      prompt: 'hi',
    });
    expect(result).toBe('openai-direct');
    expect(openai.query).toHaveBeenCalledTimes(1);
    expect(anthropic.query).not.toHaveBeenCalled();
  });

  it('routes a memory-eligible DeepAgents provider (groq) to the OpenAI-compatible client', async () => {
    const { router, anthropic, openai } = buildRouter();
    const result = await router.query({
      appId: 'default' as never,
      model: 'llama-3.3-70b-versatile',
      modelProfile: profile({
        responseFamily: OPENAI_FAMILY,
        modelRoute: 'groq',
        runnerModel: 'llama-3.3-70b-versatile',
        modelRouteLabel: 'Groq',
        alias: 'groq',
      }),
      prompt: 'remember this',
    });
    expect(result).toBe('openai-direct');
    expect(openai.query).toHaveBeenCalledTimes(1);
    expect(anthropic.query).not.toHaveBeenCalled();
  });

  it('routes a memory-eligible DeepAgents provider (gemini) to the OpenAI-compatible client', async () => {
    const { router, anthropic, openai } = buildRouter();
    const result = await router.query({
      appId: 'default' as never,
      model: 'gemini-2.5-pro',
      modelProfile: profile({
        responseFamily: OPENAI_FAMILY,
        modelRoute: 'gemini',
        runnerModel: 'gemini-2.5-pro',
        modelRouteLabel: 'Google Gemini',
        alias: 'gemini',
      }),
      prompt: 'remember this',
    });
    expect(result).toBe('openai-direct');
    expect(openai.query).toHaveBeenCalledTimes(1);
    expect(anthropic.query).not.toHaveBeenCalled();
  });

  it('fails loud on an unknown response family', async () => {
    const { router } = buildRouter();
    await expect(
      router.query({
        appId: 'default' as never,
        model: 'mystery-model',
        modelProfile: profile({ responseFamily: 'gemini', alias: 'gem' }),
        prompt: 'hi',
      }),
    ).rejects.toThrow('unsupported response family "gemini"');
  });

  it('routes profile-less legacy callers to the default-family SDK lane', async () => {
    const { router, anthropic, openai } = buildRouter();
    const result = await router.query({
      appId: 'default' as never,
      model: 'unrecognized-runner-model',
      prompt: 'hi',
    });
    expect(result).toBe('anthropic-sdk');
    expect(anthropic.query).toHaveBeenCalledTimes(1);
    expect(openai.query).not.toHaveBeenCalled();
  });

  it('is configured when any lane is configured', () => {
    const router = (a: boolean, o: boolean) =>
      createRouteAwareMemoryLlmClient({
        anthropic: fakeClient('a', a),
        openai: fakeClient('o', o),
      }).isConfigured();
    expect(router(false, true)).toBe(true);
    expect(router(true, false)).toBe(true);
    expect(router(false, false)).toBe(false);
  });

  it('dispatches optional batch operations by the declared provider capability', async () => {
    const anthropicBatch = fakeBatch('anthropic-batch');
    const openAiBatch = fakeBatch('openai-batch');
    const router = createRouteAwareMemoryLlmClient({
      anthropic: fakeClient('anthropic-sdk'),
      anthropicSingleRequest: fakeClient(
        'anthropic-direct',
        true,
        anthropicBatch,
      ),
      openai: fakeClient('openai-direct', true, openAiBatch),
    });
    await expect(
      router.batch!.submitBatch({
        appId: 'default' as never,
        model: 'claude-runner',
        modelProfile: profile({
          responseFamily: DEFAULT_FAMILY,
          modelRoute: 'anthropic',
        }),
        correlationId: 'correlation-a',
        onSubmissionStart: async () => undefined,
        requests: [{ customId: 'a', prompt: 'hi' }],
      }),
    ).resolves.toEqual({ batchId: 'anthropic-batch' });
    await expect(
      router.batch!.submitBatch({
        appId: 'default' as never,
        model: 'gpt-runner',
        modelProfile: profile({ responseFamily: OPENAI_FAMILY }),
        correlationId: 'correlation-o',
        onSubmissionStart: async () => undefined,
        requests: [{ customId: 'o', prompt: 'hi' }],
      }),
    ).resolves.toEqual({ batchId: 'openai-batch' });
    expect(anthropicBatch.submitBatch).toHaveBeenCalledTimes(1);
    expect(openAiBatch.submitBatch).toHaveBeenCalledTimes(1);
  });

  it('omits batch capability when no transport exists so callers can use live fallback', () => {
    const router = createRouteAwareMemoryLlmClient({
      anthropic: fakeClient('anthropic-sdk'),
      openai: fakeClient('openai-direct'),
    });
    expect(router.batch).toBeUndefined();
  });

  it('rejects provider-batch dispatch for a provider without declared batch support', async () => {
    const batch = fakeBatch('openai-batch');
    const router = createRouteAwareMemoryLlmClient({
      anthropic: fakeClient('anthropic-sdk'),
      openai: fakeClient('openai-direct', true, batch),
    });
    await expect(
      router.batch!.submitBatch({
        appId: 'default' as never,
        model: 'moonshotai/kimi-k2.6',
        modelProfile: profile({
          responseFamily: DEFAULT_FAMILY,
          modelRoute: 'openrouter',
          runnerModel: 'moonshotai/kimi-k2.6',
        }),
        correlationId: 'correlation-k',
        onSubmissionStart: async () => undefined,
        requests: [{ customId: 'k', prompt: 'hi' }],
      }),
    ).rejects.toThrow('does not support provider batches');
    expect(batch.submitBatch).not.toHaveBeenCalled();
  });
});
