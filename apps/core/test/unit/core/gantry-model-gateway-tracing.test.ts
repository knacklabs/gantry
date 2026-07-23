import { diag } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-node';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GantryModelGatewayBroker } from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway.js';
import type { AppId } from '@core/domain/app/app.js';
import type { RuntimeEventPublishInput } from '@core/domain/events/events.js';
import type {
  ModelCredential,
  ModelCredentialMetadata,
  ModelCredentialProvider,
} from '@core/domain/model-credentials/model-credentials.js';
import type { ModelCredentialRepository } from '@core/domain/ports/repositories.js';
import {
  initTracing,
  shutdownTracing,
  startTurnSpan,
} from '@core/infrastructure/observability/tracing.js';

const appId = 'default' as AppId;
const brokers: GantryModelGatewayBroker[] = [];
const anthropicBaseUrlKey = ['ANTHROPIC', 'BASE_URL'].join('_');
const anthropicApiKeyKey = ['ANTHROPIC', 'API_KEY'].join('_');

class CredentialRepository implements ModelCredentialRepository {
  private readonly credential: ModelCredential;

  constructor(providerId: ModelCredentialProvider) {
    const now = new Date().toISOString();
    this.credential = {
      id: `model-credential:${providerId}` as never,
      appId,
      providerId,
      authMode: 'api_key',
      status: 'active',
      schemaVersion: 1,
      payload: { apiKey: `sk-${providerId}-upstream` },
      fingerprint: `fp:${providerId}`,
      fieldFingerprints: [{ field: 'apiKey', fingerprint: `fp:${providerId}` }],
      createdAt: now,
      updatedAt: now,
    };
  }

  async getModelCredential(input: {
    appId: AppId;
    providerId: ModelCredentialProvider;
  }): Promise<ModelCredential | null> {
    return input.appId === appId &&
      input.providerId === this.credential.providerId
      ? this.credential
      : null;
  }

  async listModelCredentials(): Promise<ModelCredentialMetadata[]> {
    return [this.credential];
  }

  async upsertModelCredential(): Promise<ModelCredentialMetadata> {
    throw new Error('not needed');
  }

  async disableModelCredential(): Promise<ModelCredentialMetadata | null> {
    throw new Error('not needed');
  }
}

function tracing(exporter: SpanExporter = new InMemorySpanExporter()): void {
  initTracing({ enabled: true, captureContent: true, sampleRate: 1 }, exporter);
}

function frame(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function streamedResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function request(input: {
  url: string;
  token: string;
  body: Buffer;
  method?: 'GET' | 'POST';
}): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const method = input.method ?? 'POST';
    const req = http.request(
      input.url,
      {
        method,
        headers: {
          'x-api-key': input.token,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(method === 'POST' ? input.body : undefined);
  });
}

async function gateway(input: {
  providerId: 'anthropic' | 'openai';
  runId?: string;
  purpose?: 'model_runtime' | 'model_batch';
  modelBatchRequestCount?: number;
  audit?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
}): Promise<{ url: string; token: string }> {
  const broker = new GantryModelGatewayBroker(
    new CredentialRepository(input.providerId),
    input.audit ? { audit: input.audit } : undefined,
  );
  brokers.push(broker);
  const injection = await broker.getInjection({
    binding: {
      profile: 'gantry',
      purpose: input.purpose ?? 'model_runtime',
      appId,
      modelCredentialProviderId: input.providerId,
      ...(input.modelBatchRequestCount
        ? { modelBatchRequestCount: input.modelBatchRequestCount }
        : {}),
      ...(input.runId ? { runId: input.runId as never } : {}),
    },
  });
  return input.providerId === 'anthropic'
    ? {
        url: `${injection.env[anthropicBaseUrlKey]}/v1/messages`,
        token: injection.env[anthropicApiKeyKey]!,
      }
    : {
        url: `${injection.env.OPENAI_BASE_URL}/v1/chat/completions`,
        token: injection.env.OPENAI_API_KEY!,
      };
}

function chatSpan(exporter: InMemorySpanExporter): ReadableSpan {
  const spans = exporter
    .getFinishedSpans()
    .filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await shutdownTracing();
  diag.disable();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Gantry Model Gateway tracing', () => {
  it('records non-streaming usage and cost under the registered turn span', async () => {
    const exporter = new InMemorySpanExporter();
    tracing(exporter);
    const runId = 'run:gateway-tracing';
    const turn = startTurnSpan({ runId, agentName: 'Gateway Test Agent' });
    const responseBody = Buffer.from(
      JSON.stringify({
        id: 'msg_test',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hello' }],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(responseBody, {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const endpoint = await gateway({ providerId: 'anthropic', runId });

    const result = await request({
      ...endpoint,
      body: Buffer.from(
        JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ),
    });
    turn.end('success');

    expect(result).toEqual({ status: 200, body: responseBody });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const chat = chatSpan(exporter);
    const parent = spans.find(
      (span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent',
    )!;
    expect(chat.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(chat.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(chat.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 17,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.cache_read_input_tokens': 3,
      'gen_ai.usage.cache_creation_input_tokens': 2,
      'gen_ai.usage.cost': expect.any(Number),
    });
    expect(chat.attributes['gen_ai.usage.cost']).toBeGreaterThan(0);
  });

  it('reconstructs an Anthropic tool span across consecutive gateway requests', async () => {
    const exporter = new InMemorySpanExporter();
    tracing(exporter);
    const runId = 'run:gateway-anthropic-tool';
    const turn = startTurnSpan({ runId, agentName: 'Anthropic Tool Agent' });
    const toolResponse = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'anthropic-call',
            name: 'mcp__github__search_code',
            input: { query: 'otel' },
          },
        ],
      }),
    );
    const finalResponse = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done' }],
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(toolResponse, {
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(finalResponse, {
            headers: { 'content-type': 'application/json' },
          }),
        ),
    );
    const endpoint = await gateway({ providerId: 'anthropic', runId });

    expect(
      await request({
        ...endpoint,
        body: Buffer.from(
          JSON.stringify({
            model: 'claude-sonnet-4-6',
            messages: [{ role: 'user', content: 'Search' }],
          }),
        ),
      }),
    ).toEqual({ status: 200, body: toolResponse });
    expect(
      await request({
        ...endpoint,
        body: Buffer.from(
          JSON.stringify({
            model: 'claude-sonnet-4-6',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'anthropic-call',
                    content: [{ type: 'text', text: 'match' }],
                  },
                ],
              },
            ],
          }),
        ),
      }),
    ).toEqual({ status: 200, body: finalResponse });
    turn.end('success');

    const spans = exporter.getFinishedSpans();
    const parent = spans.find(
      (span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent',
    )!;
    const tool = spans.find(
      (span) => span.attributes['gen_ai.operation.name'] === 'execute_tool',
    )!;
    expect(tool.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(tool.attributes).toMatchObject({
      'gen_ai.tool.name': 'mcp__github__search_code',
      'gen_ai.tool.call.id': 'anthropic-call',
      'gantry.tool.transport': 'mcp',
      'gantry.mcp.server': 'github',
      'gen_ai.tool.call.arguments': JSON.stringify({ query: 'otel' }),
      'gen_ai.tool.call.result': JSON.stringify([
        { type: 'text', text: 'match' },
      ]),
      'gantry.tool.status': 'success',
    });
    const toolChat = spans.find(
      (span) =>
        typeof span.attributes['gen_ai.output.messages'] === 'string' &&
        String(span.attributes['gen_ai.output.messages']).includes(
          'anthropic-call',
        ),
    )!;
    const output = JSON.parse(
      String(toolChat.attributes['gen_ai.output.messages']),
    ) as Array<{ parts: unknown[] }>;
    expect(output[0]?.parts).toEqual([
      {
        type: 'tool_call',
        id: 'anthropic-call',
        name: 'mcp__github__search_code',
        arguments: { query: 'otel' },
      },
    ]);
    const legacyOutput = JSON.parse(
      String(toolChat.attributes['gen_ai.completion']),
    ) as Array<{ content: unknown }>;
    expect(Array.isArray(legacyOutput[0]?.content)).toBe(true);
  });

  it('captures streamed OpenAI tool calls and closes them on the next request', async () => {
    const exporter = new InMemorySpanExporter();
    tracing(exporter);
    const runId = 'run:gateway-openai-tool';
    const turn = startTurnSpan({ runId, agentName: 'OpenAI Tool Agent' });
    const toolStream =
      frame({
        model: 'gpt-5.5',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'openai-',
                  function: {
                    name: 'mcp_call_',
                    arguments: '{"serverName":"linear",',
                  },
                },
              ],
            },
          },
        ],
      }) +
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call',
                  function: {
                    name: 'tool',
                    arguments: '"toolName":"search_issues"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }) +
      frame('[DONE]');
    const finalResponse = Buffer.from(
      JSON.stringify({
        model: 'gpt-5.5',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Done' },
          },
        ],
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(streamedResponse([toolStream]))
        .mockResolvedValueOnce(
          new Response(finalResponse, {
            headers: { 'content-type': 'application/json' },
          }),
        ),
    );
    const endpoint = await gateway({ providerId: 'openai', runId });

    expect(
      await request({
        ...endpoint,
        body: Buffer.from(
          JSON.stringify({
            model: 'gpt-5.5',
            stream: true,
            stream_options: { include_usage: true },
            messages: [{ role: 'user', content: 'Search' }],
          }),
        ),
      }),
    ).toEqual({ status: 200, body: Buffer.from(toolStream) });
    expect(
      await request({
        ...endpoint,
        body: Buffer.from(
          JSON.stringify({
            model: 'gpt-5.5',
            messages: [
              {
                role: 'tool',
                tool_call_id: 'openai-call',
                content: JSON.stringify({ issues: [1] }),
              },
            ],
          }),
        ),
      }),
    ).toEqual({ status: 200, body: finalResponse });
    turn.end('success');

    const tool = exporter
      .getFinishedSpans()
      .find(
        (span) => span.attributes['gen_ai.operation.name'] === 'execute_tool',
      )!;
    expect(tool.attributes).toMatchObject({
      'gen_ai.tool.name': 'mcp_call_tool',
      'gen_ai.tool.call.id': 'openai-call',
      'gantry.tool.transport': 'mcp',
      'gantry.mcp.server': 'linear',
      'gen_ai.tool.call.arguments': JSON.stringify({
        serverName: 'linear',
        toolName: 'search_issues',
      }),
      'gen_ai.tool.call.result': JSON.stringify({ issues: [1] }),
      'gantry.tool.status': 'unknown',
    });
  });

  it('registers streamed tool calls before a slow usage audit settles', async () => {
    const exporter = new InMemorySpanExporter();
    tracing(exporter);
    const runId = 'run:gateway-delayed-audit';
    const turn = startTurnSpan({ runId, agentName: 'Delayed Audit Agent' });
    let releaseAudit!: () => void;
    const delayedAudit = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    let forwardedAudits = 0;
    const audit = (event: RuntimeEventPublishInput) => {
      if (event.payload.outcome !== 'forwarded') return undefined;
      forwardedAudits += 1;
      return forwardedAudits === 1 ? delayedAudit : undefined;
    };
    const toolStream =
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'delayed-audit-call',
                  function: { name: 'Read', arguments: '{"path":"/tmp/a"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }) + frame('[DONE]');
    const finalResponse = Buffer.from(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Done' },
          },
        ],
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(streamedResponse([toolStream]))
        .mockResolvedValueOnce(
          new Response(finalResponse, {
            headers: { 'content-type': 'application/json' },
          }),
        ),
    );
    const endpoint = await gateway({ providerId: 'openai', runId, audit });

    await request({
      ...endpoint,
      body: Buffer.from(
        JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'Read' }],
        }),
      ),
    });
    await request({
      ...endpoint,
      body: Buffer.from(
        JSON.stringify({
          model: 'gpt-5.5',
          messages: [
            {
              role: 'tool',
              tool_call_id: 'delayed-audit-call',
              content: 'read result',
            },
          ],
        }),
      ),
    });
    releaseAudit();
    turn.end('success');

    const tool = exporter
      .getFinishedSpans()
      .find(
        (span) => span.attributes['gen_ai.operation.name'] === 'execute_tool',
      );
    expect(tool?.attributes).toMatchObject({
      'gen_ai.tool.call.id': 'delayed-audit-call',
      'gantry.tool.status': 'unknown',
      'gen_ai.tool.call.result': 'read result',
    });
  });

  it('preserves chunked Anthropic SSE bytes and records streamed usage', async () => {
    const exporter = new InMemorySpanExporter();
    tracing(exporter);
    const source = [
      frame({
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 11,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
          },
        },
      }),
      frame({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello ' },
      }),
      frame({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'world' },
      }),
      frame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 3 },
      }),
    ].join('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamedResponse([
          source.slice(0, 47),
          source.slice(47, 139),
          source.slice(139),
        ]),
      ),
    );
    const endpoint = await gateway({ providerId: 'anthropic' });

    const result = await request({
      ...endpoint,
      body: Buffer.from(
        JSON.stringify({
          model: 'claude-sonnet-4-6',
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ),
    });

    expect(result).toEqual({ status: 200, body: Buffer.from(source) });
    expect(chatSpan(exporter).attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 17,
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.usage.cache_read_input_tokens': 4,
      'gen_ai.usage.cache_creation_input_tokens': 2,
      'gen_ai.response.finish_reasons': ['end_turn'],
      'gen_ai.completion': JSON.stringify([
        { role: 'assistant', content: 'Hello world' },
      ]),
    });
  });

  it('injects OpenAI stream usage, strips its frame, and records cached tokens', async () => {
    const exporter = new InMemorySpanExporter();
    tracing(exporter);
    const content = frame({
      model: 'gpt-5.5',
      choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
    });
    const usage = frame({
      model: 'gpt-5.5',
      choices: [],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    });
    const done = frame('[DONE]');
    let upstreamBody: Buffer | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, options?: RequestInit) => {
        upstreamBody = Buffer.from(options?.body as Buffer);
        return streamedResponse([
          content.slice(0, 23),
          content.slice(23) + usage,
          done,
        ]);
      }),
    );
    const endpoint = await gateway({ providerId: 'openai' });

    const result = await request({
      ...endpoint,
      body: Buffer.from(
        JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ),
    });

    expect(JSON.parse(upstreamBody!.toString('utf8'))).toMatchObject({
      stream_options: { include_usage: true },
    });
    expect(result).toEqual({ status: 200, body: Buffer.from(content + done) });
    expect(result.body.toString('utf8')).not.toContain('prompt_tokens');
    expect(chatSpan(exporter).attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 9,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.cached_tokens': 5,
      'gen_ai.response.finish_reasons': ['stop'],
    });
  });

  it('preserves caller-set include_usage requests and usage frames byte-for-byte', async () => {
    const exporter = new InMemorySpanExporter();
    tracing(exporter);
    const body = Buffer.from(
      '{"model":"gpt-5.5","stream":true,"stream_options":{"include_usage":true},"messages":[]}',
    );
    const source =
      frame({
        model: 'gpt-5.5',
        choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
      }) +
      frame({
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }) +
      frame('[DONE]');
    let upstreamBody: Buffer | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, options?: RequestInit) => {
        upstreamBody = Buffer.from(options?.body as Buffer);
        return streamedResponse([source.slice(0, 51), source.slice(51)]);
      }),
    );
    const endpoint = await gateway({ providerId: 'openai' });

    const result = await request({ ...endpoint, body });

    expect(upstreamBody).toEqual(body);
    expect(result).toEqual({ status: 200, body: Buffer.from(source) });
    expect(result.body.toString('utf8')).toContain('prompt_tokens');
    expect(chatSpan(exporter).attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 3,
      'gen_ai.usage.output_tokens': 1,
    });
  });

  it.each([
    ['anthropic', '/v1/messages/batches', 'POST'],
    ['openai', '/v1/files', 'POST'],
    ['openai', '/v1/batches', 'GET'],
  ] as const)(
    'does not trace %s%s transport requests as chat generations',
    async (providerId, path, method) => {
      const exporter = new InMemorySpanExporter();
      tracing(exporter);
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('{"object":"batch"}', {
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
      const endpoint = await gateway({
        providerId,
        purpose: 'model_batch',
        modelBatchRequestCount: 1,
      });
      const url = new URL(endpoint.url);
      url.pathname = `/${providerId}${path}`;

      const result = await request({
        ...endpoint,
        url: url.href,
        body: Buffer.from('{}'),
        method,
      });

      expect(result.status).toBe(200);
      expect(exporter.getFinishedSpans()).toEqual([]);
    },
  );
  it('is byte-identical and emits no spans when tracing is disabled', async () => {
    const exporter = new InMemorySpanExporter();
    initTracing(
      { enabled: false, captureContent: true, sampleRate: 1 },
      exporter,
    );
    const responseBody = Buffer.from('{"result":"unchanged"}\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(responseBody, {
            status: 202,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const endpoint = await gateway({ providerId: 'anthropic' });

    const result = await request({
      ...endpoint,
      body: Buffer.from('{"model":"claude-sonnet-4-6"}'),
    });

    expect(result).toEqual({ status: 202, body: responseBody });
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('leaves sampled-out requests untouched and exports no spans', async () => {
    const exporter = new InMemorySpanExporter();
    initTracing(
      { enabled: true, captureContent: true, sampleRate: 0 },
      exporter,
    );
    const content = frame({
      model: 'gpt-5.5',
      choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
    });
    const done = frame('[DONE]');
    let upstreamBody: Buffer | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, options?: RequestInit) => {
        upstreamBody = Buffer.from(options?.body as Buffer);
        return streamedResponse([content, done]);
      }),
    );
    const endpoint = await gateway({ providerId: 'openai' });
    const requestBody = Buffer.from(
      JSON.stringify({
        model: 'gpt-5.5',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    );

    const result = await request({ ...endpoint, body: requestBody });

    expect(upstreamBody).toEqual(requestBody);
    expect(result).toEqual({ status: 200, body: Buffer.from(content + done) });
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('keeps the proxied status and body when the span exporter throws', async () => {
    let exportCalls = 0;
    const exporter: SpanExporter = {
      export() {
        exportCalls += 1;
        throw new Error('export failed');
      },
      shutdown: async () => undefined,
    };
    tracing(exporter);
    const responseBody = Buffer.from('{"result":"still proxied"}');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(responseBody, {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const endpoint = await gateway({ providerId: 'anthropic' });

    const result = await request({
      ...endpoint,
      body: Buffer.from('{"model":"claude-sonnet-4-6"}'),
    });

    expect(result).toEqual({ status: 201, body: responseBody });
    await vi.waitFor(() => expect(exportCalls).toBeGreaterThan(0));
  });
});
