import { describe, expect, it } from 'vitest';

import { buildRunnerModel } from '@core/adapters/llm/deepagents-langchain/runner/model-factory.js';

// This test intentionally does not import the LangChain chat-model classes so it
// stays outside the provider boundary; it asserts the resolved model's
// constructor name instead of using `instanceof`. Model construction is
// provider-driven: the host projects the provider string + model id + the single
// loopback gateway base-url/token.

const loopbackBaseUrl = 'http://127.0.0.1:4567/openai';
const openrouterBaseUrl = 'http://127.0.0.1:4567/openrouter';
const sandboxOpenrouterBaseUrl =
  'http://model-gateway.gantry.internal:4567/openrouter';
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

  it.each([
    ['groq', 'llama-3.3-70b-versatile', 'http://127.0.0.1:4567/groq'],
    ['deepseek', 'deepseek-v4-pro', 'http://127.0.0.1:4567/deepseek'],
    [
      'together',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'http://127.0.0.1:4567/together',
    ],
    ['bedrock', 'openai.gpt-oss-120b-1:0', 'http://127.0.0.1:4567/bedrock'],
    ['vertex', 'google/gemini-3.5-flash', 'http://127.0.0.1:4567/vertex'],
  ])(
    'builds a ChatOpenAI via the gateway baseURL for the %s provider (not ChatOpenRouter)',
    async (provider, modelId, providerBaseUrl) => {
      const resolved = await buildRunnerModel({
        provider,
        modelId,
        gatewayBaseUrl: providerBaseUrl,
        gatewayToken,
      });
      // The OpenAI-compatible providers go through initChatModel("openai:<id>")
      // and resolve to ChatOpenAI bound to the RAW loopback gateway baseURL
      // (no /v1) — the gateway prepends each provider's real upstream prefix.
      expect(resolved.endpointFamily).toBe('openai');
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
      expect(underlying.model).toBe(modelId);
      expect(underlying.streamUsage).toBe(true);
      expect(underlying.clientConfig?.baseURL).toBe(providerBaseUrl);
      expect(underlying.apiKey).toBe(gatewayToken);
      expect(resolved.modelId).toBe(modelId);
    },
  );

  it('builds a ChatOpenRouter bound to the loopback /v1 gateway path', async () => {
    const resolved = await buildRunnerModel({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
      gatewayBaseUrl: openrouterBaseUrl,
      gatewayToken,
    });
    expect(resolved.endpointFamily).toBe('openrouter');
    // GantryChatOpenRouter extends ChatOpenRouter (adds only a profile-override
    // getter); the OpenRouter wire behavior below is unchanged.
    expect(resolved.model.constructor.name).toBe('GantryChatOpenRouter');
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

  it('accepts the sandbox-runtime private gateway alias', async () => {
    const resolved = await buildRunnerModel({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
      gatewayBaseUrl: sandboxOpenrouterBaseUrl,
      gatewayToken,
    });

    const model = resolved.model as unknown as {
      baseURL: string;
      apiKey?: string;
    };
    expect(model.baseURL).toBe(`${sandboxOpenrouterBaseUrl}/v1`);
    expect(model.apiKey).toBe(gatewayToken);
  });

  it('threads the durable session id into ChatOpenRouter for sticky cache routing', async () => {
    const resolved = await buildRunnerModel({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
      gatewayBaseUrl: openrouterBaseUrl,
      gatewayToken,
      sessionId: 'durable-session-123',
    });
    // ChatOpenRouter injects body `session_id` from the constructor sessionId
    // (invocationParams), so OpenRouter routes follow-up turns to the same
    // upstream provider/cache.
    const model = resolved.model as unknown as { sessionId?: string };
    expect(model.sessionId).toBe('durable-session-123');
  });

  it('threads OpenRouter provider preferences into the request body', async () => {
    const providerRouting = {
      only: ['moonshotai'],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny' as const,
      sort: 'latency' as const,
    };
    const resolved = await buildRunnerModel({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
      gatewayBaseUrl: openrouterBaseUrl,
      gatewayToken,
      openRouterProviderRouting: providerRouting,
    });

    const model = resolved.model as unknown as {
      provider?: unknown;
      invocationParams: (options: Record<string, unknown>) => {
        provider?: unknown;
      };
    };
    expect(model.provider).toEqual(providerRouting);
    expect(model.invocationParams({}).provider).toEqual(providerRouting);
  });

  it('omits sessionId for the openai lane (session_id is OpenRouter-only)', async () => {
    const resolved = await buildRunnerModel({
      provider: 'openai',
      modelId: 'gpt-5.5',
      gatewayBaseUrl: loopbackBaseUrl,
      gatewayToken,
      sessionId: 'durable-session-123',
    });
    const underlying = await (
      resolved.model as unknown as {
        _getModelInstance: () => Promise<Record<string, unknown>>;
      }
    )._getModelInstance();
    // ChatOpenAI has no session_id concept; the durable id is not applied.
    expect('sessionId' in underlying).toBe(false);
    expect((underlying as { session_id?: unknown }).session_id).toBeUndefined();
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

  it('rejects unknown providers outside the explicit DeepAgents allowlist', async () => {
    await expect(
      buildRunnerModel({
        provider: 'unregistered-provider',
        modelId: 'future-model',
        gatewayBaseUrl: loopbackBaseUrl,
        gatewayToken,
      }),
    ).rejects.toThrow(
      'DeepAgents runner does not support model provider "unregistered-provider"',
    );
  });

  it('rejects a non-loopback baseURL', async () => {
    await expect(
      buildRunnerModel({
        provider: 'openai',
        modelId: 'gpt-5.5',
        gatewayBaseUrl: 'https://api.openai.com',
        gatewayToken,
      }),
    ).rejects.toThrow(
      'must be a loopback or sandbox-private Gantry gateway URL',
    );
  });

  it('rejects arbitrary private gateway-looking hosts', async () => {
    await expect(
      buildRunnerModel({
        provider: 'openai',
        modelId: 'gpt-5.5',
        gatewayBaseUrl: 'http://model-gateway.internal:4567/openai',
        gatewayToken,
      }),
    ).rejects.toThrow(
      'must be a loopback or sandbox-private Gantry gateway URL',
    );
  });

  it('accepts the sandbox-runtime model gateway alias', async () => {
    const sandboxGatewayBaseUrl =
      'http://model-gateway.gantry.internal:4567/openai';
    const resolved = await buildRunnerModel({
      provider: 'openai',
      modelId: 'gpt-5.5',
      gatewayBaseUrl: sandboxGatewayBaseUrl,
      gatewayToken,
    });
    const underlying = await (
      resolved.model as unknown as {
        _getModelInstance: () => Promise<{
          clientConfig?: { baseURL?: string };
        }>;
      }
    )._getModelInstance();
    expect(underlying.clientConfig?.baseURL).toBe(sandboxGatewayBaseUrl);
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

  it('projects the curated window onto the openai-lane model profile', async () => {
    // A curated-window model (e.g. groq llama) must carry maxInputTokens on the
    // resolved model profile so DeepAgents summarization triggers on the real
    // window (85%) and context-usage reports a correct %.
    const resolved = await buildRunnerModel({
      provider: 'groq',
      modelId: 'llama-3.3-70b-versatile',
      gatewayBaseUrl: 'http://127.0.0.1:4567/groq',
      gatewayToken,
      maxInputTokens: 131_072,
    });
    const profile = (resolved.model as unknown as { profile?: unknown })
      .profile;
    expect(profile).toMatchObject({ maxInputTokens: 131_072 });
  });

  it('omits the profile override for the openai lane when no window is given', async () => {
    // gpt-5.5 has a real LangChain profile; without a curated window the factory
    // must leave that library profile in place (NOT inject an empty override).
    const resolved = await buildRunnerModel({
      provider: 'openai',
      modelId: 'gpt-5.5',
      gatewayBaseUrl: loopbackBaseUrl,
      gatewayToken,
    });
    // ConfigurableModel._profile is unset, so .profile falls through to the
    // inner library profile (gpt-5.5 has a real ~1.05M window).
    const profile = (resolved.model as unknown as { profile?: unknown })
      .profile as { maxInputTokens?: number } | undefined;
    // The override was not applied; whatever window appears comes from the
    // library (a real number > 400k), never the curated value.
    expect(profile?.maxInputTokens).not.toBe(131_072);
  });

  it('projects the curated window onto the GantryChatOpenRouter profile', async () => {
    const resolved = await buildRunnerModel({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
      gatewayBaseUrl: openrouterBaseUrl,
      gatewayToken,
      maxInputTokens: 262_142,
    });
    expect(resolved.model.constructor.name).toBe('GantryChatOpenRouter');
    const profile = (resolved.model as unknown as { profile?: unknown })
      .profile;
    expect(profile).toMatchObject({ maxInputTokens: 262_142 });
  });

  it('falls back to the library profile for openrouter without a curated window', async () => {
    const resolved = await buildRunnerModel({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
      gatewayBaseUrl: openrouterBaseUrl,
      gatewayToken,
    });
    // No override -> GantryChatOpenRouter.profile returns super.profile, which is
    // PROFILES[model] ?? {} (empty for this id), so no curated value leaks.
    const profile = (resolved.model as unknown as { profile?: unknown })
      .profile as { maxInputTokens?: number };
    expect(profile.maxInputTokens).toBeUndefined();
  });
});
