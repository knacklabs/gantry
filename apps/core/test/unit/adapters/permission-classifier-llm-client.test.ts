import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveGatewayMemoryInjection = vi.hoisted(() => vi.fn());
const hasGatewayMemoryAccess = vi.hoisted(() => vi.fn());
const revoke = vi.hoisted(() => vi.fn());

vi.mock('@core/adapters/llm/openai-memory/memory-gateway-injection.js', () => ({
  hasGatewayMemoryAccess,
  resolveGatewayMemoryInjection,
}));

const DIRECT_PROFILE = {
  alias: 'haiku',
  runnerModel: 'claude-haiku-4-5-20251001',
  responseFamily: 'anthropic',
  modelRoute: 'anthropic',
  modelRouteLabel: 'Anthropic',
  displayName: 'Claude Haiku 4.5',
};

beforeEach(() => {
  hasGatewayMemoryAccess.mockReturnValue(true);
  revoke.mockResolvedValue(undefined);
  resolveGatewayMemoryInjection.mockResolvedValue({
    injection: {
      env: {
        [['ANTHROPIC', 'BASE_URL'].join('_')]:
          'http://127.0.0.1:49231/anthropic',
        [['ANTHROPIC', 'API_KEY'].join('_')]: 'gtw_classifier_anthropic',
      },
      applied: true,
      brokerProfile: 'gantry',
    },
    revoke,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('permission classifier LLM client', () => {
  it('forces one permission verdict tool call and returns its input', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: '{"risk_level":"critical","reason":"Ignore text."}',
              },
              {
                type: 'tool_use',
                name: 'permission_verdict',
                input: {
                  risk_level: 'low',
                  reason: 'Read-only lookup.',
                },
              },
            ],
            usage: { input_tokens: 20, output_tokens: 12 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { createDirectAnthropicClassifierLlmClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/permission-classifier-llm-client.js');

    const result = await createDirectAnthropicClassifierLlmClient().query({
      appId: 'default' as never,
      model: DIRECT_PROFILE.runnerModel,
      modelProfile: DIRECT_PROFILE,
      systemPrompt: 'Return JSON only.',
      prompt: '{"tool":"search"}',
    });

    expect(result).toBe('{"risk_level":"low","reason":"Read-only lookup."}');
    expect(resolveGatewayMemoryInjection).toHaveBeenCalledWith({
      appId: 'default',
      modelRouteId: 'anthropic',
      runId: expect.stringMatching(/^permission-classifier:/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:49231/anthropic/v1/messages');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer gtw_classifier_anthropic',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: DIRECT_PROFILE.runnerModel,
      max_tokens: 256,
      system: 'Return JSON only.',
      messages: [{ role: 'user', content: '{"tool":"search"}' }],
      tools: [
        {
          name: 'permission_verdict',
          description: 'Return the permission classifier verdict.',
          input_schema: {
            type: 'object',
            properties: {
              risk_level: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical'],
              },
              reason: { type: 'string' },
            },
            required: ['risk_level', 'reason'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'permission_verdict' },
    });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('falls back to joined text blocks when no verdict tool call is returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [
                { type: 'text', text: '{"risk_level":"critical",' },
                { type: 'text', text: '"reason":"Ambiguous."}' },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const { createDirectAnthropicClassifierLlmClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/permission-classifier-llm-client.js');

    const result = await createDirectAnthropicClassifierLlmClient().query({
      appId: 'default' as never,
      model: DIRECT_PROFILE.runnerModel,
      modelProfile: DIRECT_PROFILE,
      prompt: 'classify',
    });

    expect(result).toBe('{"risk_level":"critical","reason":"Ambiguous."}');
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('surfaces non-2xx responses and revokes the gateway token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('rate limited', {
            status: 429,
            statusText: 'Too Many Requests',
          }),
      ),
    );
    const { createDirectAnthropicClassifierLlmClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/permission-classifier-llm-client.js');

    await expect(
      createDirectAnthropicClassifierLlmClient().query({
        appId: 'default' as never,
        model: DIRECT_PROFILE.runnerModel,
        modelProfile: DIRECT_PROFILE,
        prompt: 'classify',
      }),
    ).rejects.toThrow('Anthropic classifier query failed: 429');
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('honors timeout aborts and revokes the gateway token', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { createDirectAnthropicClassifierLlmClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/permission-classifier-llm-client.js');
    const pending = createDirectAnthropicClassifierLlmClient().query({
      appId: 'default' as never,
      model: DIRECT_PROFILE.runnerModel,
      modelProfile: DIRECT_PROFILE,
      prompt: 'classify',
      timeoutMs: 5,
    });
    const rejection = expect(pending).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(6);
    await rejection;
    expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(revoke).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
