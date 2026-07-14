import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  MemoryLlmQueryOpts,
  MemoryLlmUsage,
} from '@core/domain/ports/memory-llm-client.js';

const resolveGatewayMemoryInjectionMock = vi.hoisted(() => vi.fn());
const hasGatewayMemoryAccessMock = vi.hoisted(() => vi.fn());
const revokeMock = vi.hoisted(() => vi.fn());

vi.mock('@core/adapters/llm/openai-memory/memory-gateway-injection.js', () => ({
  hasGatewayMemoryAccess: hasGatewayMemoryAccessMock,
  resolveGatewayMemoryInjection: resolveGatewayMemoryInjectionMock,
}));

// Mirror the REAL broker projection: the gateway projects
// OPENAI_BASE_URL = `http://<host>:<port>/<provider.gateway.pathSegment>` (no
// /v1) — the segment differs PER PROVIDER (openai, groq, gemini, ...). The old
// fixed `/openai` base masked the double-/v1 bug because every provider looked
// like openai. Derive the segment from the requested modelRouteId so the test
// composes the same upstream path the runtime would.
const GATEWAY_HOST_BASE = 'http://127.0.0.1:49231';

function gatewayEnvForRoute(modelRouteId: string) {
  return {
    OPENAI_BASE_URL: `${GATEWAY_HOST_BASE}/${modelRouteId}`,
    OPENAI_API_KEY: 'gtw_memory_openai',
  };
}

const GATEWAY_ENV = gatewayEnvForRoute('openai');

function chatCompletionBody() {
  return {
    choices: [{ message: { content: 'openai memory result' } }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 34,
      prompt_tokens_details: { cached_tokens: 80 },
    },
  };
}

beforeEach(() => {
  hasGatewayMemoryAccessMock.mockReturnValue(true);
  revokeMock.mockResolvedValue(undefined);
  // Project the base URL for the route the client actually requests, so the
  // composed upstream path is verified per provider (no fixed `/openai` mask).
  resolveGatewayMemoryInjectionMock.mockImplementation(
    async (input: { modelRouteId: string }) => ({
      injection: {
        env: gatewayEnvForRoute(input.modelRouteId),
        applied: true,
        brokerProfile: 'gantry',
      },
      revoke: revokeMock,
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const OPENAI_PROFILE = {
  alias: 'gpt',
  runnerModel: 'gpt-test',
  responseFamily: 'openai',
  modelRoute: 'openai',
  modelRouteLabel: 'OpenAI',
  displayName: 'GPT Test',
};

describe('OpenAI memory LLM client', () => {
  it('posts to the brokered chat-completions endpoint with the gateway bearer token', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(chatCompletionBody()), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');
    const client = createOpenAiMemoryLlmClient();

    const usageSeen: MemoryLlmUsage[] = [];
    const result = await client.query({
      appId: 'default' as never,
      model: 'gpt-test',
      modelProfile: OPENAI_PROFILE,
      prompt: 'fallback prompt',
      systemPrompt: 'system instructions',
      userBlocks: [
        { text: 'static block', cacheStatic: true },
        { text: 'dynamic block' },
      ],
      onUsage: (usage) => usageSeen.push(usage),
    });

    expect(result).toBe('openai memory result');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:49231/openai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer gtw_memory_openai');
    expect(init.headers['content-type']).toBe('application/json');

    expect(init.body).toBe(
      JSON.stringify({
        model: 'gpt-test',
        messages: [
          { role: 'system', content: 'system instructions' },
          { role: 'user', content: 'static block' },
          { role: 'user', content: 'dynamic block' },
        ],
      }),
    );

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-test');
    expect(body.messages).toEqual([
      { role: 'system', content: 'system instructions' },
      { role: 'user', content: 'static block' },
      { role: 'user', content: 'dynamic block' },
    ]);

    // cacheStatic is a no-op for OpenAI automatic prefix caching.
    expect(JSON.stringify(body)).not.toContain('cache_control');

    // OpenAI cached_tokens is a subset of prompt_tokens (120); the canonical
    // usage treats input and cache-read as disjoint, so input_tokens excludes
    // the cached portion: 120 - 80 = 40.
    expect(usageSeen).toEqual([
      {
        input_tokens: 40,
        output_tokens: 34,
        cache_read_input_tokens: 80,
      },
    ]);

    // Run-scoped gateway token is always revoked.
    expect(revokeMock).toHaveBeenCalledTimes(1);
  });

  it('requires the permission verdict schema for single-request classifier queries', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(chatCompletionBody()), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');
    const query = {
      appId: 'default' as never,
      model: 'gpt-test',
      modelProfile: OPENAI_PROFILE,
      prompt: 'classify this permission request',
      singleRequest: true,
    } satisfies MemoryLlmQueryOpts & { singleRequest: true };

    await createOpenAiMemoryLlmClient().query(query);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'permission_verdict',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['allow', 'ask'] },
            reason: { type: 'string' },
          },
          required: ['decision', 'reason'],
          additionalProperties: false,
        },
      },
    });
  });

  it('falls back to the plain prompt when no user blocks are provided', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(chatCompletionBody()), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');

    await createOpenAiMemoryLlmClient().query({
      appId: 'default' as never,
      model: 'gpt-test',
      modelProfile: OPENAI_PROFILE,
      prompt: 'just the prompt',
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages).toEqual([
      { role: 'user', content: 'just the prompt' },
    ]);
  });

  it('reports isConfigured from gateway access', async () => {
    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');
    hasGatewayMemoryAccessMock.mockReturnValue(false);
    expect(createOpenAiMemoryLlmClient().isConfigured()).toBe(false);
    hasGatewayMemoryAccessMock.mockReturnValue(true);
    expect(createOpenAiMemoryLlmClient().isConfigured()).toBe(true);
  });

  it('throws a clear setup error when the gateway is not configured', async () => {
    hasGatewayMemoryAccessMock.mockReturnValue(false);
    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');

    await expect(
      createOpenAiMemoryLlmClient().query({
        appId: 'default' as never,
        model: 'gpt-test',
        modelProfile: OPENAI_PROFILE,
        prompt: 'hello',
      }),
    ).rejects.toThrow('OpenAI memory access is not configured');
  });

  it('surfaces upstream HTTP errors and still revokes the token', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('rate limited', {
          status: 429,
          statusText: 'Too Many Requests',
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');

    await expect(
      createOpenAiMemoryLlmClient().query({
        appId: 'default' as never,
        model: 'gpt-test',
        modelProfile: OPENAI_PROFILE,
        prompt: 'hello',
      }),
    ).rejects.toThrow('OpenAI memory query failed: 429');
    expect(revokeMock).toHaveBeenCalledTimes(1);
  });

  it('aborts and revokes the token when the timeout elapses', async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');

    await expect(
      createOpenAiMemoryLlmClient().query({
        appId: 'default' as never,
        model: 'gpt-test',
        modelProfile: OPENAI_PROFILE,
        prompt: 'hello',
        timeoutMs: 5,
      }),
    ).rejects.toThrow();
    expect(revokeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-OpenAI-compatible model route before issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');

    // The Anthropic route is the Claude SDK lane (not chat/completions).
    await expect(
      createOpenAiMemoryLlmClient().query({
        appId: 'default' as never,
        model: 'gpt-test',
        modelProfile: {
          ...OPENAI_PROFILE,
          modelRoute: ['anth', 'ropic'].join(''),
        },
        prompt: 'hello',
      }),
    ).rejects.toThrow('is not an OpenAI-compatible model route');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('targets the gateway projection for a memory-eligible DeepAgents provider (groq)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(chatCompletionBody()), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');

    const result = await createOpenAiMemoryLlmClient().query({
      appId: 'default' as never,
      model: 'llama-3.3-70b-versatile',
      modelProfile: {
        ...OPENAI_PROFILE,
        modelRoute: 'groq',
        runnerModel: 'llama-3.3-70b-versatile',
        modelRouteLabel: 'Groq',
        alias: 'groq',
      },
      prompt: 'remember this',
    });
    expect(result).toBe('openai memory result');
    // groq's gateway prefix already carries `/openai/v1`, so the client must
    // post the BARE `/chat/completions` tail (matching the runner lane + the
    // gateway allowlist). The gateway then composes
    // api.groq.com/openai/v1/chat/completions upstream — posting `/v1/chat/
    // completions` here would double the version and 404.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:49231/groq/chat/completions');
    expect(init.headers.authorization).toBe('Bearer gtw_memory_openai');
    expect(JSON.parse(init.body as string).model).toBe(
      'llama-3.3-70b-versatile',
    );
  });

  it('reads a flat per-provider cache-read usage field (deepseek prompt_cache_hit_tokens)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 200,
              completion_tokens: 10,
              // DeepSeek reports cache reads on a FLAT field, not the nested
              // prompt_tokens_details.cached_tokens path.
              prompt_cache_hit_tokens: 150,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');

    const usageSeen: MemoryLlmUsage[] = [];
    await createOpenAiMemoryLlmClient().query({
      appId: 'default' as never,
      model: 'deepseek-v4-pro',
      modelProfile: {
        ...OPENAI_PROFILE,
        modelRoute: 'deepseek',
        runnerModel: 'deepseek-v4-pro',
        modelRouteLabel: 'DeepSeek',
        alias: 'deepseek',
      },
      prompt: 'remember this',
      onUsage: (usage) => usageSeen.push(usage),
    });

    // Flat cache field is read by the provider-declared path: 200 - 150 = 50.
    expect(usageSeen).toEqual([
      { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 150 },
    ]);
  });

  // The path the client POSTs, combined with the REAL provider registry's
  // upstreamOrigin + upstreamPathPrefix (and prefix-strip allowlist), must
  // resolve to the correct upstream URL — no double `/v1` (the bug for
  // prefix-carrying providers) and no missing `/v1` (the risk for openai whose
  // prefix is '').
  it.each([
    [
      'openai',
      'gpt-test',
      'http://127.0.0.1:49231/openai/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
    ],
    [
      'groq',
      'llama-3.3-70b-versatile',
      'http://127.0.0.1:49231/groq/chat/completions',
      'https://api.groq.com/openai/v1/chat/completions',
    ],
    [
      'openrouter',
      'moonshotai/kimi-k2.6',
      'http://127.0.0.1:49231/openrouter/v1/chat/completions',
      'https://openrouter.ai/api/v1/chat/completions',
    ],
    [
      'gemini',
      'gemini-2.5-flash',
      'http://127.0.0.1:49231/gemini/chat/completions',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ],
  ])(
    'composes the correct upstream path for %s (no double/missing /v1)',
    async (modelRoute, model, expectedClientUrl, expectedUpstreamUrl) => {
      const { getModelProviderDefinition } =
        await import('@core/shared/model-provider-registry.js');
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify(chatCompletionBody()), { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const { createOpenAiMemoryLlmClient } =
        await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');

      await createOpenAiMemoryLlmClient().query({
        appId: 'default' as never,
        model,
        modelProfile: { ...OPENAI_PROFILE, modelRoute, runnerModel: model },
        prompt: 'remember this',
      });

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe(expectedClientUrl);

      // Re-derive the gateway's upstream URL from the tail the client posted:
      // base = http://host/<segment>, so the tail is everything after /<segment>.
      const posted = new URL(url as string);
      const tail = posted.pathname.replace(`/${modelRoute}`, '');
      const provider = getModelProviderDefinition(modelRoute)!;
      const upstream = `${provider.gateway.upstreamOrigin}${provider.gateway.upstreamPathPrefix}${tail}`;
      expect(upstream).toBe(expectedUpstreamUrl);
      // No double `/v1` anywhere in the composed upstream path.
      expect(upstream).not.toMatch(/\/v1\/v1\//);
    },
  );

  it('accepts the OpenRouter route (OpenAI-compatible DeepAgents lane)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(chatCompletionBody()), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');

    const result = await createOpenAiMemoryLlmClient().query({
      appId: 'default' as never,
      model: 'moonshotai/kimi-k2.6',
      modelProfile: {
        ...OPENAI_PROFILE,
        modelRoute: 'openrouter',
        runnerModel: 'moonshotai/kimi-k2.6',
        alias: 'kimi',
      },
      prompt: 'hello',
    });
    expect(result).toBe('openai memory result');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
