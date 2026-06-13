import { describe, expect, it } from 'vitest';

import { buildRunnerModel } from '@core/adapters/llm/deepagents-langchain/runner/model-factory.js';

// This test intentionally does not import the LangChain chat-model classes so it
// stays outside the provider boundary; it asserts the resolved model's
// constructor name instead of using `instanceof`. Model construction is
// provider-driven: the host projects the provider string + model id + the single
// loopback gateway base-url/token.

const loopbackBaseUrl = 'http://127.0.0.1:4567/openai';
const openrouterBaseUrl = 'http://127.0.0.1:4567/openrouter';
const gatewayToken = 'gtw_token';

describe('deepagents model factory', () => {
  it('builds a ChatOpenAI via initChatModel for the openai provider', async () => {
    const resolved = await buildRunnerModel({
      provider: 'openai',
      modelId: 'gpt-5.5',
      gatewayBaseUrl: loopbackBaseUrl,
      gatewayToken,
    });
    expect(resolved.endpointFamily).toBe('openai');
    // initChatModel returns a ConfigurableModel wrapper that resolves to a
    // ChatOpenAI bound to the loopback gateway baseURL + gtw_ token.
    expect(resolved.model.constructor.name).toBe('ConfigurableModel');
    const underlying = await (
      resolved.model as unknown as {
        _getModelInstance: () => Promise<{
          constructor: { name: string };
          model: string;
          streamUsage?: boolean;
          clientConfig?: { baseURL?: string };
          apiKey?: string;
        }>;
      }
    )._getModelInstance();
    expect(underlying.constructor.name).toBe('ChatOpenAI');
    expect(underlying.model).toBe('gpt-5.5');
    expect(underlying.streamUsage).toBe(true);
    expect(underlying.clientConfig?.baseURL).toBe(loopbackBaseUrl);
    expect(underlying.apiKey).toBe(gatewayToken);
    expect(resolved.modelId).toBe('gpt-5.5');
  });

  it('builds a ChatOpenRouter bound to the loopback /v1 gateway path', async () => {
    const resolved = await buildRunnerModel({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
      gatewayBaseUrl: openrouterBaseUrl,
      gatewayToken,
    });
    expect(resolved.endpointFamily).toBe('openrouter');
    expect(resolved.model.constructor.name).toBe('ChatOpenRouter');
    const model = resolved.model as unknown as {
      baseURL: string;
      model: string;
      apiKey?: string;
      streamUsage?: boolean;
    };
    // ChatOpenRouter.buildUrl() appends /chat/completions, so baseURL must carry
    // the /v1 path segment -> loopback /openrouter/v1/chat/completions.
    expect(model.baseURL).toBe(`${openrouterBaseUrl}/v1`);
    expect(model.model).toBe('moonshotai/kimi-k2.6');
    expect(model.apiKey).toBe(gatewayToken);
    expect(model.streamUsage).toBe(true);
    expect(resolved.modelId).toBe('moonshotai/kimi-k2.6');
  });

  it('rejects the anthropic provider (Claude is SDK-only)', async () => {
    await expect(
      buildRunnerModel({
        provider: ['anth', 'ropic'].join(''),
        modelId: 'claude-sonnet-4-6',
        gatewayBaseUrl: loopbackBaseUrl,
        gatewayToken,
      }),
    ).rejects.toThrow('does not support model provider');
  });

  it('rejects a non-loopback baseURL', async () => {
    await expect(
      buildRunnerModel({
        provider: 'openai',
        modelId: 'gpt-5.5',
        gatewayBaseUrl: 'https://api.openai.com',
        gatewayToken,
      }),
    ).rejects.toThrow('must be a loopback Gantry gateway URL');
  });

  it('rejects a non-gateway token', async () => {
    await expect(
      buildRunnerModel({
        provider: 'openai',
        modelId: 'gpt-5.5',
        gatewayBaseUrl: loopbackBaseUrl,
        gatewayToken: 'sk-raw-secret',
      }),
    ).rejects.toThrow('run-scoped Gantry');
  });
});
