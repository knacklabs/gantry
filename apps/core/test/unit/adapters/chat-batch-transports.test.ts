import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchBatchJsonl } from '@core/adapters/llm/chat-batch-http.js';

const resolveGatewayMemoryInjectionMock = vi.hoisted(() => vi.fn());
const revokeMock = vi.hoisted(() => vi.fn());

vi.mock('@core/adapters/llm/openai-memory/memory-gateway-injection.js', () => ({
  hasGatewayMemoryAccess: () => true,
  resolveGatewayMemoryInjection: resolveGatewayMemoryInjectionMock,
}));

const OPENAI_PROFILE = {
  alias: 'gpt',
  runnerModel: 'gpt-5.5',
  responseFamily: 'openai',
  modelRoute: 'openai',
  modelRouteLabel: 'OpenAI',
  displayName: 'GPT Test',
};

const CLAUDE_PROFILE = {
  alias: 'claude',
  runnerModel: 'claude-opus-4-8',
  responseFamily: 'anthropic',
  modelRoute: 'anthropic',
  modelRouteLabel: 'Anthropic',
  displayName: 'Claude Test',
};
const CLAUDE_BASE_URL_ENV = ['ANTHROPIC', 'BASE', 'URL'].join('_');
const CLAUDE_API_KEY_ENV = ['ANTHROPIC', 'API', 'KEY'].join('_');

beforeEach(() => {
  revokeMock.mockResolvedValue(undefined);
  resolveGatewayMemoryInjectionMock.mockImplementation(
    async (input: { modelRouteId: string }) => ({
      injection: {
        brokerAuthMode: 'api_key',
        env:
          input.modelRouteId === 'anthropic'
            ? {
                [CLAUDE_BASE_URL_ENV]: 'http://127.0.0.1:49231/anthropic',
                [CLAUDE_API_KEY_ENV]: 'gtw_anthropic_batch',
              }
            : {
                OPENAI_BASE_URL: 'http://127.0.0.1:49231/openai',
                OPENAI_API_KEY: 'gtw_openai_batch',
              },
      },
      revoke: revokeMock,
    }),
  );
});

it('streams JSONL with cumulative byte and row limits', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response('{"id":1}\n'))
      .mockResolvedValueOnce(new Response('{"id":1}\n{"id":2}\n')),
  );

  await expect(
    fetchBatchJsonl({
      provider: 'Test',
      operation: 'result download',
      url: 'https://provider.test/too-large',
      maxBytes: 4,
      maxRows: 10,
    }),
  ).rejects.toThrow('exceeded the 4 byte limit');
  await expect(
    fetchBatchJsonl({
      provider: 'Test',
      operation: 'result download',
      url: 'https://provider.test/too-many',
      maxBytes: 100,
      maxRows: 1,
    }),
  ).rejects.toThrow('exceeded the 1 row limit');
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('rejects serialized provider upload bodies over 14 MiB before fetch', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const [
    { createOpenAiChatBatchCapability },
    { createAnthropicChatBatchCapability },
  ] = await Promise.all([
    import('@core/adapters/llm/openai-memory/openai-chat-batch.js'),
    import('@core/adapters/llm/anthropic-claude-agent/anthropic-chat-batch.js'),
  ]);
  // Seven MiB of this two-byte UTF-8 character exceeds the 14 MiB provider
  // limit once the request envelope is serialized.
  const oversizedPrompt = 'é'.repeat(7 * 1024 * 1024);
  await expect(
    createOpenAiChatBatchCapability().submitBatch({
      appId: 'default' as never,
      model: 'gpt-test',
      modelProfile: OPENAI_PROFILE,
      correlationId: 'oversized-openai',
      onSubmissionStart: async () => undefined,
      requests: [{ customId: 'request-1', prompt: oversizedPrompt }],
    }),
  ).rejects.toThrow('OpenAI batch upload is');
  await expect(
    createAnthropicChatBatchCapability().submitBatch({
      appId: 'default' as never,
      model: 'claude-test',
      modelProfile: CLAUDE_PROFILE,
      correlationId: 'oversized-anthropic',
      onSubmissionStart: async () => undefined,
      requests: [{ customId: 'request-1', prompt: oversizedPrompt }],
    }),
  ).rejects.toThrow('Anthropic batch upload is');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(revokeMock).toHaveBeenCalledTimes(2);
});

describe('OpenAI chat batch transport', () => {
  it('uploads, submits with correlation metadata, polls, downloads, and reconciles', async () => {
    const submissionEvents: string[] = [];
    const fetchMock = vi.fn(
      async (urlInput: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(urlInput));
        const method = init?.method ?? 'GET';
        if (url.pathname.endsWith('/v1/files') && method === 'POST') {
          submissionEvents.push('upload');
          return Response.json({ id: 'file-input' });
        }
        if (url.pathname.endsWith('/v1/batches') && method === 'POST') {
          submissionEvents.push('create');
          return Response.json({ id: 'batch-openai' });
        }
        if (url.pathname.endsWith('/v1/batches/batch-openai')) {
          return Response.json({
            id: 'batch-openai',
            status: 'completed',
            output_file_id: 'file-output',
            error_file_id: 'file-error',
          });
        }
        if (url.pathname.endsWith('/v1/files/file-output/content')) {
          return new Response(
            `${JSON.stringify({
              custom_id: 'request-1',
              response: {
                status_code: 200,
                body: {
                  choices: [{ message: { content: '{"answer":"ok"}' } }],
                  usage: {
                    prompt_tokens: 120,
                    completion_tokens: 20,
                    prompt_tokens_details: { cached_tokens: 80 },
                  },
                },
              },
            })}\n`,
          );
        }
        if (url.pathname.endsWith('/v1/files/file-error/content')) {
          return new Response(
            `${JSON.stringify({
              custom_id: 'request-2',
              error: { code: 'invalid_request', message: 'bad request' },
            })}\n`,
          );
        }
        if (url.pathname.endsWith('/v1/batches') && method === 'GET') {
          return Response.json({
            data: [
              {
                id: 'batch-openai',
                metadata: {
                  gantry_batch_correlation_id: 'correlation-1',
                },
              },
            ],
            has_more: false,
          });
        }
        throw new Error(`unexpected request ${method} ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createOpenAiChatBatchCapability } =
      await import('@core/adapters/llm/openai-memory/openai-chat-batch.js');
    const batch = createOpenAiChatBatchCapability();
    const scope = {
      appId: 'default' as never,
      model: 'gpt-5.5',
      modelProfile: OPENAI_PROFILE,
    };
    await expect(
      batch.submitBatch({
        ...scope,
        correlationId: 'correlation-1',
        onSubmissionStart: async () => {
          submissionEvents.push('submission_start');
        },
        maxOutputTokens: 500,
        requests: [
          {
            customId: 'request-1',
            prompt: 'fallback',
            systemPrompt: 'system',
            userBlocks: [{ text: 'question', cacheStatic: true }],
            responseSchema: {
              name: 'answer',
              schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
                additionalProperties: false,
              },
            },
          },
        ],
      }),
    ).resolves.toEqual({ batchId: 'batch-openai' });
    expect(submissionEvents).toEqual(['upload', 'submission_start', 'create']);

    const uploadCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/v1/files') && init?.method === 'POST',
    )!;
    const form = uploadCall[1]?.body as FormData;
    const jsonl = await (form.get('file') as Blob).text();
    expect(JSON.parse(jsonl)).toEqual({
      custom_id: 'request-1',
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5.5',
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'question' },
        ],
        max_completion_tokens: 500,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'answer',
            strict: true,
            schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        },
      },
    });
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/v1/batches') && init?.method === 'POST',
    )!;
    expect(JSON.parse(createCall[1]?.body as string)).toMatchObject({
      input_file_id: 'file-input',
      endpoint: '/v1/chat/completions',
      metadata: { gantry_batch_correlation_id: 'correlation-1' },
    });

    await expect(
      batch.pollBatch({ ...scope, batchId: 'batch-openai' }),
    ).resolves.toEqual({ batchId: 'batch-openai', state: 'completed' });
    await expect(
      batch.fetchBatchResults({ ...scope, batchId: 'batch-openai' }),
    ).resolves.toEqual([
      {
        customId: 'request-1',
        text: '{"answer":"ok"}',
        usage: {
          input_tokens: 120,
          output_tokens: 20,
          cache_read_input_tokens: 80,
          provider_reported_cost_usd: expect.closeTo(0.00042, 10),
        },
      },
      {
        customId: 'request-2',
        error: '{"code":"invalid_request","message":"bad request"}',
      },
    ]);
    await expect(
      batch.findBatchByCorrelationId({
        ...scope,
        correlationId: 'correlation-1',
      }),
    ).resolves.toEqual({ batchId: 'batch-openai' });
    expect(
      resolveGatewayMemoryInjectionMock.mock.calls.map(
        ([input]) => input.modelBatchId,
      ),
    ).toEqual([undefined, 'batch-openai', 'batch-openai', undefined]);
    expect(revokeMock).toHaveBeenCalledTimes(4);
  });

  it('does not enter provider submission when the prerequisite upload fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response('upload unavailable', {
          status: 503,
          statusText: 'Unavailable',
        }),
      ),
    );
    const { createOpenAiChatBatchCapability } =
      await import('@core/adapters/llm/openai-memory/openai-chat-batch.js');
    const onSubmissionStart = vi.fn(async () => undefined);

    await expect(
      createOpenAiChatBatchCapability().submitBatch({
        appId: 'default' as never,
        model: 'gpt-5.5',
        modelProfile: OPENAI_PROFILE,
        correlationId: 'upload-failure',
        onSubmissionStart,
        requests: [{ customId: 'request-1', prompt: 'question' }],
      }),
    ).rejects.toThrow('OpenAI batch input upload failed: 503');
    expect(onSubmissionStart).not.toHaveBeenCalled();
  });

  it('enters provider submission after upload and before batch creation can fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ id: 'file-input' }))
        .mockResolvedValueOnce(
          new Response('create unavailable', {
            status: 503,
            statusText: 'Unavailable',
          }),
        ),
    );
    const { createOpenAiChatBatchCapability } =
      await import('@core/adapters/llm/openai-memory/openai-chat-batch.js');
    const onSubmissionStart = vi.fn(async () => undefined);

    await expect(
      createOpenAiChatBatchCapability().submitBatch({
        appId: 'default' as never,
        model: 'gpt-5.5',
        modelProfile: OPENAI_PROFILE,
        correlationId: 'create-failure',
        onSubmissionStart,
        requests: [{ customId: 'request-1', prompt: 'question' }],
      }),
    ).rejects.toThrow('OpenAI batch submission failed: 503');
    expect(onSubmissionStart).toHaveBeenCalledOnce();
  });

  it('throws on a result download failure and malformed JSONL', async () => {
    const { createOpenAiChatBatchCapability } =
      await import('@core/adapters/llm/openai-memory/openai-chat-batch.js');
    const batch = createOpenAiChatBatchCapability();
    const scope = {
      appId: 'default' as never,
      model: 'gpt-5.5',
      modelProfile: OPENAI_PROFILE,
      batchId: 'batch-openai',
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ output_file_id: 'file-output' }))
        .mockResolvedValueOnce(
          new Response('download unavailable', {
            status: 503,
            statusText: 'Unavailable',
          }),
        ),
    );
    await expect(batch.fetchBatchResults(scope)).rejects.toThrow(
      'OpenAI batch result download failed: 503',
    );

    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ output_file_id: 'file-output' }))
      .mockResolvedValueOnce(new Response('{not json}\n'));
    await expect(batch.fetchBatchResults(scope)).rejects.toThrow(
      'OpenAI batch result JSONL line 1 is invalid',
    );
    expect(revokeMock).toHaveBeenCalledTimes(2);
  });
});

describe('Anthropic chat batch transport', () => {
  it('submits, polls, parses result fixtures, and reconciles read-only without a false match', async () => {
    const fetchMock = vi.fn(
      async (urlInput: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(urlInput));
        const method = init?.method ?? 'GET';
        if (
          url.pathname.endsWith('/v1/messages/batches') &&
          method === 'POST'
        ) {
          return Response.json({ id: 'batch-anthropic' });
        }
        if (url.pathname.endsWith('/v1/messages/batches/batch-anthropic')) {
          return Response.json({
            id: 'batch-anthropic',
            processing_status: 'ended',
          });
        }
        if (
          url.pathname.endsWith('/v1/messages/batches/batch-anthropic/results')
        ) {
          return new Response(
            [
              JSON.stringify({
                custom_id: 'request-1',
                result: {
                  type: 'succeeded',
                  message: {
                    content: [
                      {
                        type: 'tool_use',
                        name: 'answer',
                        input: { answer: 'ok' },
                      },
                    ],
                    usage: {
                      input_tokens: 40,
                      output_tokens: 12,
                      cache_read_input_tokens: 60,
                      cache_creation_input_tokens: 10,
                    },
                  },
                },
              }),
              JSON.stringify({
                custom_id: 'request-2',
                result: {
                  type: 'errored',
                  error: { type: 'invalid_request', message: 'bad request' },
                },
              }),
            ].join('\n'),
          );
        }
        if (url.pathname.endsWith('/v1/messages/batches') && method === 'GET') {
          return Response.json({ data: [{ id: 'some-other-batch' }] });
        }
        throw new Error(`unexpected request ${method} ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createAnthropicChatBatchCapability } =
      await import('@core/adapters/llm/anthropic-claude-agent/anthropic-chat-batch.js');
    const batch = createAnthropicChatBatchCapability();
    const scope = {
      appId: 'default' as never,
      model: 'claude-opus-4-8',
      modelProfile: CLAUDE_PROFILE,
    };
    await expect(
      batch.submitBatch({
        ...scope,
        correlationId: 'correlation-2',
        onSubmissionStart: async () => undefined,
        maxOutputTokens: 700,
        requests: [
          {
            customId: 'request-1',
            prompt: 'fallback',
            userBlocks: [{ text: 'question', cacheStatic: true }],
            responseSchema: {
              name: 'answer',
              schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
                additionalProperties: false,
              },
            },
          },
        ],
      }),
    ).resolves.toEqual({ batchId: 'batch-anthropic' });
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/v1/messages/batches') && init?.method === 'POST',
    )!;
    const createBody = JSON.parse(createCall[1]?.body as string);
    expect(createBody).toEqual({
      requests: [
        {
          custom_id: 'request-1',
          params: {
            model: 'claude-opus-4-8',
            max_tokens: 700,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'question',
                    cache_control: { type: 'ephemeral' },
                  },
                ],
              },
            ],
            tools: [
              {
                name: 'answer',
                input_schema: {
                  type: 'object',
                  properties: { answer: { type: 'string' } },
                  required: ['answer'],
                  additionalProperties: false,
                },
              },
            ],
            tool_choice: { type: 'tool', name: 'answer' },
          },
        },
      ],
    });
    expect(JSON.stringify(createBody)).not.toContain('correlation-2');

    await expect(
      batch.pollBatch({ ...scope, batchId: 'batch-anthropic' }),
    ).resolves.toEqual({ batchId: 'batch-anthropic', state: 'completed' });
    await expect(
      batch.fetchBatchResults({ ...scope, batchId: 'batch-anthropic' }),
    ).resolves.toEqual([
      {
        customId: 'request-1',
        text: '{"answer":"ok"}',
        usage: {
          input_tokens: 40,
          output_tokens: 12,
          cache_read_input_tokens: 60,
          cache_creation_input_tokens: 10,
          provider_reported_cost_usd: expect.closeTo(0.00029625, 10),
        },
      },
      {
        customId: 'request-2',
        error: '{"type":"invalid_request","message":"bad request"}',
      },
    ]);
    await expect(
      batch.findBatchByCorrelationId({
        ...scope,
        correlationId: 'correlation-2',
      }),
    ).resolves.toBeNull();
    const listCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/v1/messages/batches?limit=100') &&
        init?.method === 'GET',
    );
    expect(listCall).toBeDefined();
    expect(revokeMock).toHaveBeenCalledTimes(4);
  });
});
