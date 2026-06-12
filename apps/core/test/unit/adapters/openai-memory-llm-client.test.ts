import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryLlmUsage } from '@core/domain/ports/memory-llm-client.js';

const resolveGatewayMemoryInjectionMock = vi.hoisted(() => vi.fn());
const hasGatewayMemoryAccessMock = vi.hoisted(() => vi.fn());
const revokeMock = vi.hoisted(() => vi.fn());

vi.mock('@core/adapters/llm/openai-memory/memory-gateway-injection.js', () => ({
  hasGatewayMemoryAccess: hasGatewayMemoryAccessMock,
  resolveGatewayMemoryInjection: resolveGatewayMemoryInjectionMock,
}));

const GATEWAY_ENV = {
  OPENAI_BASE_URL: 'http://127.0.0.1:49231/openai',
  OPENAI_API_KEY: 'gtw_memory_openai',
};

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
  resolveGatewayMemoryInjectionMock.mockResolvedValue({
    injection: { env: GATEWAY_ENV, applied: true, brokerProfile: 'gantry' },
    revoke: revokeMock,
  });
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

  it('rejects a non-OpenAI-family model route before issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiMemoryLlmClient } =
      await import('@core/adapters/llm/openai-memory/openai-memory-llm-client.js');

    await expect(
      createOpenAiMemoryLlmClient().query({
        appId: 'default' as never,
        model: 'gpt-test',
        modelProfile: { ...OPENAI_PROFILE, modelRoute: 'openrouter' },
        prompt: 'hello',
      }),
    ).rejects.toThrow('is not an OpenAI-family model route');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
