import { afterEach, describe, expect, it } from 'vitest';
import { diag } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';

import {
  observeGatewayCall,
  type GatewayCallObservation,
} from '@core/adapters/llm/observability/genai-spans.js';
import {
  createSseAccumulator,
  createSseFrameSplitter,
  isOpenAiUsageOnlyFrame,
} from '@core/adapters/llm/observability/sse-accumulator.js';
import {
  initTracing,
  shutdownTracing,
  startTurnSpan,
} from '@core/infrastructure/observability/tracing.js';
import { createSpawnTurnTracker } from '@core/infrastructure/observability/spawn-turn-tracker.js';

const OPENAI_URL = new URL('https://llm.example/v1/chat/completions');
const MESSAGES_URL = new URL('https://llm.example/v1/messages');

function init(captureContent = true): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  initTracing(
    {
      enabled: true,
      captureContent,
      sampleRate: 1,
    },
    exporter,
  );
  return exporter;
}

function observe(input: {
  request: Record<string, unknown>;
  upstreamUrl?: URL;
  runId?: string;
  apiKeyId?: string;
  providerId?: string;
}): GatewayCallObservation {
  const observation = observeGatewayCall({
    token: { runId: input.runId, apiKeyId: input.apiKeyId },
    providerId: input.providerId ?? 'fixture-provider',
    upstreamUrl: input.upstreamUrl ?? OPENAI_URL,
    requestBody: Buffer.from(JSON.stringify(input.request)),
  });
  expect(observation).toBeDefined();
  return observation!;
}

function chatSpan(exporter: InMemorySpanExporter): ReadableSpan {
  const span = exporter
    .getFinishedSpans()
    .find(
      (candidate) => candidate.attributes['gen_ai.operation.name'] === 'chat',
    );
  expect(span).toBeDefined();
  return span!;
}

function toolSpans(exporter: InMemorySpanExporter): ReadableSpan[] {
  return exporter
    .getFinishedSpans()
    .filter(
      (span) => span.attributes['gen_ai.operation.name'] === 'execute_tool',
    );
}

function frame(data: unknown, newline = '\n'): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${payload}${newline}${newline}`;
}

afterEach(async () => {
  await shutdownTracing();
  diag.disable();
});

describe('observeGatewayCall', () => {
  it('parents a matching gateway span to the registered turn span', () => {
    const exporter = init();
    const turn = startTurnSpan({
      runId: 'run-parent',
      agentName: 'Parent Agent',
    });
    const observation = observe({
      runId: 'run-parent',
      request: { model: 'request-model', messages: [] },
    });

    observation.finish({ status: 200, responseJson: {} });
    turn.end('success');

    const spans = exporter.getFinishedSpans();
    const gateway = spans.find((span) => span.name === 'chat request-model')!;
    const parent = spans.find(
      (span) => span.name === 'invoke_agent Parent Agent',
    )!;
    expect(gateway.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(gateway.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(gateway.attributes['gantry.component']).toBeUndefined();
  });

  it.each([
    [{ apiKeyId: 'key-1', runId: 'unregistered-key-run' }, 'llm-api'],
    [{ runId: 'memory-query:abc' }, 'memory'],
    [{ runId: 'permission-classifier:abc' }, 'permission-classifier'],
    [{ runId: 'unregistered-run' }, 'unattributed'],
  ] as const)(
    'makes unmatched calls root spans with component %s',
    (token, component) => {
      const exporter = init();
      const observation = observe({
        ...token,
        request: { model: 'request-model', messages: [] },
      });

      observation.finish({ status: 200, responseJson: {} });

      const span = chatSpan(exporter);
      expect(span.parentSpanContext).toBeUndefined();
      expect(span.attributes['gantry.component']).toBe(component);
    },
  );

  it('maps Anthropic response attributes and content', () => {
    const exporter = init();
    const observation = observe({
      upstreamUrl: MESSAGES_URL,
      request: {
        model: 'request-model',
        max_tokens: 512,
        system: 'System fixture',
        messages: [{ role: 'user', content: 'Prompt fixture' }],
      },
    });

    observation.finish({
      status: 200,
      responseJson: {
        id: 'response-id',
        model: 'response-model',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Completion fixture' }],
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        },
      },
    });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes).toMatchObject({
      'gen_ai.provider.name': 'fixture-provider',
      'gen_ai.system': 'fixture-provider',
      'gen_ai.request.model': 'request-model',
      'gen_ai.response.model': 'response-model',
      'gen_ai.response.id': 'response-id',
      'gen_ai.response.finish_reasons': ['end_turn'],
      'gen_ai.usage.input_tokens': 20,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.usage.cache_read_input_tokens': 5,
      'gen_ai.usage.cache_creation_input_tokens': 3,
      'gen_ai.usage.cache_read.input_tokens': 5,
      'gen_ai.usage.cache_creation.input_tokens': 3,
    });
    expect(JSON.parse(String(attributes['gen_ai.prompt']))).toEqual([
      { role: 'system', content: 'System fixture' },
      { role: 'user', content: 'Prompt fixture' },
    ]);
    expect(JSON.parse(String(attributes['gen_ai.completion']))).toEqual([
      { role: 'assistant', content: 'Completion fixture' },
    ]);
    expect(JSON.parse(String(attributes['gen_ai.input.messages']))).toEqual([
      {
        role: 'system',
        parts: [{ type: 'text', content: 'System fixture' }],
      },
      {
        role: 'user',
        parts: [{ type: 'text', content: 'Prompt fixture' }],
      },
    ]);
    expect(JSON.parse(String(attributes['gen_ai.output.messages']))).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'Completion fixture' }],
        finish_reason: 'end_turn',
      },
    ]);
  });

  it('dual-emits the current and legacy xAI provider identifiers', () => {
    const exporter = init();
    const observation = observe({
      providerId: 'xai',
      request: { model: 'grok-4', messages: [] },
    });

    observation.finish({ status: 200, responseJson: {} });

    expect(chatSpan(exporter).attributes).toMatchObject({
      'gen_ai.provider.name': 'x_ai',
      'gen_ai.system': 'xai',
    });
  });

  it('maps OpenAI response attributes including cached tokens', () => {
    const exporter = init();
    const observation = observe({
      request: {
        model: 'request-model',
        temperature: 0.2,
        messages: [{ role: 'user', content: 'Prompt fixture' }],
      },
    });

    observation.finish({
      status: 200,
      responseJson: {
        model: 'response-model',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Completion fixture' },
          },
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 4,
          total_tokens: 13,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      },
    });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes).toMatchObject({
      'gen_ai.request.model': 'request-model',
      'gen_ai.response.model': 'response-model',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 9,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.total_tokens': 13,
      'gen_ai.usage.cached_tokens': 6,
    });
    expect(JSON.parse(String(attributes['gen_ai.prompt']))).toEqual([
      { role: 'user', content: 'Prompt fixture' },
    ]);
    expect(JSON.parse(String(attributes['gen_ai.completion']))).toEqual([
      { role: 'assistant', content: 'Completion fixture' },
    ]);
    expect(JSON.parse(String(attributes['gen_ai.input.messages']))).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', content: 'Prompt fixture' }],
      },
    ]);
    expect(JSON.parse(String(attributes['gen_ai.output.messages']))).toEqual([
      {
        role: 'assistant',
        index: 0,
        parts: [{ type: 'text', content: 'Completion fixture' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('preserves the Anthropic system prompt at the message cap', () => {
    const exporter = init();
    const observation = observe({
      upstreamUrl: MESSAGES_URL,
      request: {
        model: 'request-model',
        system: 'Keep this system prompt',
        messages: Array.from({ length: 64 }, (_, index) => ({
          role: 'user',
          content: `message-${index}`,
        })),
      },
    });
    observation.finish({ status: 200, responseJson: {} });

    const attributes = chatSpan(exporter).attributes;
    const legacy = JSON.parse(String(attributes['gen_ai.prompt'])) as Array<{
      role: string;
      content: string;
    }>;
    const current = JSON.parse(
      String(attributes['gen_ai.input.messages']),
    ) as Array<{ role: string; parts: unknown[] }>;
    expect(legacy).toHaveLength(64);
    expect(legacy[0]).toEqual({
      role: 'system',
      content: 'Keep this system prompt',
    });
    expect(legacy[1]?.content).toBe('message-1');
    expect(current[0]).toEqual({
      role: 'system',
      parts: [{ type: 'text', content: 'Keep this system prompt' }],
    });
  });

  it('preserves Anthropic media blocks while omitting private reasoning blocks', () => {
    const exporter = init();
    const observation = observe({
      upstreamUrl: MESSAGES_URL,
      request: {
        model: 'request-model',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'thinking', thinking: 'private reasoning' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'aGVsbG8=',
                },
              },
              {
                type: 'document',
                source: { type: 'text', data: 'document contents' },
              },
              { type: 'redacted_thinking', data: 'private redaction' },
            ],
          },
        ],
      },
    });
    observation.finish({
      status: 200,
      responseJson: {
        stop_reason: 'end_turn',
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'server-tool-1',
            content: [{ type: 'web_search_result', title: 'Visible result' }],
          },
        ],
      },
    });

    const attributes = chatSpan(exporter).attributes;
    const legacy = String(attributes['gen_ai.prompt']);
    const current = String(attributes['gen_ai.input.messages']);
    expect(legacy).toContain('image/png');
    expect(legacy).toContain('document contents');
    expect(current).toContain('image/png');
    expect(current).toContain('document contents');
    expect(legacy).not.toContain('private reasoning');
    expect(legacy).not.toContain('private redaction');
    expect(current).not.toContain('private reasoning');
    expect(current).not.toContain('private redaction');
    expect(String(attributes['gen_ai.completion'])).toContain('Visible result');
    expect(String(attributes['gen_ai.output.messages'])).toContain(
      'Visible result',
    );
  });

  it('preserves visible OpenAI multimodal and refusal parts', () => {
    const exporter = init();
    const observation = observe({
      request: {
        model: 'request-model',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'https://example.test/image.png' },
              },
              {
                type: 'input_audio',
                input_audio: { data: 'YXVkaW8=', format: 'wav' },
              },
              { type: 'file', file: { file_id: 'file-visible' } },
              { type: 'refusal', refusal: 'visible input refusal' },
              { type: 'reasoning', content: 'private input reasoning' },
            ],
          },
        ],
      },
    });
    observation.finish({
      status: 200,
      responseJson: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: [
                { type: 'refusal', refusal: 'visible output refusal' },
                { type: 'reasoning', content: 'private output reasoning' },
              ],
              refusal: 'top-level refusal',
            },
          },
        ],
      },
    });

    const attributes = chatSpan(exporter).attributes;
    for (const key of ['gen_ai.prompt', 'gen_ai.input.messages']) {
      const value = String(attributes[key]);
      expect(value).toContain('https://example.test/image.png');
      expect(value).toContain('YXVkaW8=');
      expect(value).toContain('file-visible');
      expect(value).toContain('visible input refusal');
      expect(value).not.toContain('private input reasoning');
    }
    for (const key of ['gen_ai.completion', 'gen_ai.output.messages']) {
      const value = String(attributes[key]);
      expect(value).toContain('visible output refusal');
      expect(value).toContain('top-level refusal');
      expect(value).not.toContain('private output reasoning');
    }
  });

  it('reconstructs parallel Anthropic tools and nests delegation under its tool span', () => {
    const exporter = init();
    const runId = 'run-anthropic-tools';
    const turn = startTurnSpan({ runId, agentName: 'Tool Parent' });
    const first = observe({
      runId,
      upstreamUrl: MESSAGES_URL,
      request: {
        model: 'request-model',
        messages: [{ role: 'user', content: 'Use the tools' }],
      },
    });
    const assistantContent = [
      {
        type: 'tool_use',
        id: 'tool-local',
        name: 'Read',
        input: { path: '/tmp/a' },
      },
      {
        type: 'tool_use',
        id: 'tool-mcp',
        name: 'mcp__github__search_code',
        input: { query: 'trace' },
      },
      {
        type: 'tool_use',
        id: 'tool-delegate',
        name: 'delegate_task',
        input: { objective: 'Inspect the trace' },
      },
    ];
    first.finish({
      status: 200,
      responseJson: {
        model: 'response-model',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'private chain of thought' },
          ...assistantContent,
        ],
      },
    });

    const delegationReceipt =
      'Queued: task_trace_inspector\n{"id":"task_trace_inspector"}';
    const second = observe({
      runId,
      upstreamUrl: MESSAGES_URL,
      request: {
        model: 'request-model',
        messages: [
          { role: 'assistant', content: assistantContent },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-local',
                content: 'read failed',
                is_error: true,
              },
              {
                type: 'tool_result',
                tool_use_id: 'tool-mcp',
                content: [{ type: 'text', text: 'match' }],
              },
              {
                type: 'tool_result',
                tool_use_id: 'tool-delegate',
                content: delegationReceipt,
              },
            ],
          },
        ],
      },
    });
    const delegated = createSpawnTurnTracker(
      'Trace Inspector',
      {
        runId: 'run-delegated-tool',
        parentRunId: runId,
        parentTaskId: 'task_trace_inspector',
        prompt: 'Inspect the trace',
      },
      undefined,
    );
    delegated.finish({ status: 'success', result: 'nested result' });
    second.finish({
      status: 200,
      responseJson: { content: [{ type: 'text', text: 'Done' }] },
    });
    turn.end('success');

    const spans = exporter.getFinishedSpans();
    const parent = spans.find(
      (span) =>
        span.attributes['gantry.run_id'] === runId &&
        span.attributes['gen_ai.operation.name'] === 'invoke_agent',
    )!;
    const tools = toolSpans(exporter);
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(tool.attributes).toMatchObject({
        'gen_ai.tool.type': 'function',
        'gantry.tool.timing': 'reconstructed',
        'gantry.run_id': runId,
        'gantry.tool.latency_ms': expect.any(Number),
      });
    }
    const local = tools.find(
      (span) => span.attributes['gen_ai.tool.call.id'] === 'tool-local',
    )!;
    expect(local.attributes).toMatchObject({
      'gen_ai.tool.name': 'Read',
      'gantry.tool.transport': 'local',
      'gantry.tool.status': 'error',
      'gen_ai.tool.call.arguments': JSON.stringify({ path: '/tmp/a' }),
      'gen_ai.tool.call.result': 'read failed',
      'error.type': 'tool_error',
    });
    expect(local.status.code).toBe(2);
    const mcp = tools.find(
      (span) => span.attributes['gen_ai.tool.call.id'] === 'tool-mcp',
    )!;
    expect(mcp.attributes).toMatchObject({
      'gen_ai.tool.name': 'mcp__github__search_code',
      'gantry.tool.transport': 'mcp',
      'gantry.mcp.server': 'github',
      'gantry.tool.status': 'success',
      'gen_ai.tool.call.result': JSON.stringify([
        { type: 'text', text: 'match' },
      ]),
    });
    const delegate = tools.find(
      (span) => span.attributes['gen_ai.tool.call.id'] === 'tool-delegate',
    )!;
    expect(delegate.attributes['gantry.tool.transport']).toBe('delegation');
    const child = spans.find(
      (span) => span.attributes['gantry.run_id'] === 'run-delegated-tool',
    )!;
    expect(child.parentSpanContext?.spanId).toBe(delegate.spanContext().spanId);

    const structuredOutput = spans.find(
      (span) =>
        typeof span.attributes['gen_ai.output.messages'] === 'string' &&
        String(span.attributes['gen_ai.output.messages']).includes(
          'tool-local',
        ),
    )!;
    const output = JSON.parse(
      String(structuredOutput.attributes['gen_ai.output.messages']),
    ) as Array<{ parts: unknown; finish_reason?: string }>;
    expect(output).toEqual([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'tool-local',
            name: 'Read',
            arguments: { path: '/tmp/a' },
          },
          {
            type: 'tool_call',
            id: 'tool-mcp',
            name: 'mcp__github__search_code',
            arguments: { query: 'trace' },
          },
          {
            type: 'tool_call',
            id: 'tool-delegate',
            name: 'delegate_task',
            arguments: { objective: 'Inspect the trace' },
          },
        ],
        finish_reason: 'tool_use',
      },
    ]);
    expect(
      String(structuredOutput.attributes['gen_ai.completion']),
    ).not.toContain('private chain of thought');
    expect(
      JSON.parse(String(structuredOutput.attributes['gen_ai.completion'])),
    ).toEqual([{ role: 'assistant', content: assistantContent }]);
    const structuredInput = spans.find(
      (span) =>
        typeof span.attributes['gen_ai.input.messages'] === 'string' &&
        String(span.attributes['gen_ai.input.messages']).includes(
          'tool_call_response',
        ),
    )!;
    const prompt = JSON.parse(
      String(structuredInput.attributes['gen_ai.input.messages']),
    ) as Array<{ role: string; parts: unknown[] }>;
    expect(prompt[1]).toEqual({
      role: 'tool',
      parts: [
        {
          type: 'tool_call_response',
          id: 'tool-local',
          response: 'read failed',
        },
        {
          type: 'tool_call_response',
          id: 'tool-mcp',
          response: [{ type: 'text', text: 'match' }],
        },
        {
          type: 'tool_call_response',
          id: 'tool-delegate',
          response: delegationReceipt,
        },
      ],
    });
    expect(
      Array.isArray(
        (
          JSON.parse(
            String(structuredInput.attributes['gen_ai.prompt']),
          ) as Array<{
            content: unknown;
          }>
        )[1]?.content,
      ),
    ).toBe(true);
  });

  it('reconstructs OpenAI tool calls and derives MCP proxy metadata', () => {
    const exporter = init();
    const runId = 'run-openai-tools';
    const turn = startTurnSpan({ runId, agentName: 'OpenAI Tool Parent' });
    const first = observe({
      runId,
      request: {
        model: 'request-model',
        messages: [{ role: 'user', content: 'Search' }],
      },
    });
    first.finish({
      status: 200,
      responseJson: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-openai',
                  type: 'function',
                  function: {
                    name: 'mcp_call_tool',
                    arguments: JSON.stringify({
                      serverName: 'linear',
                      toolName: 'search_issues',
                      arguments: { query: 'otel' },
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const second = observe({
      runId,
      request: {
        model: 'request-model',
        messages: [
          {
            role: 'tool',
            tool_call_id: 'call-openai',
            content: JSON.stringify({ issues: [1, 2] }),
          },
        ],
      },
    });
    second.finish({ status: 200, responseJson: { choices: [] } });
    turn.end('success');

    const tool = toolSpans(exporter)[0]!;
    expect(tool.attributes).toMatchObject({
      'gen_ai.tool.name': 'mcp_call_tool',
      'gen_ai.tool.call.id': 'call-openai',
      'gen_ai.tool.type': 'function',
      'gantry.tool.transport': 'mcp',
      'gantry.mcp.server': 'linear',
      'gantry.tool.status': 'unknown',
      'gen_ai.tool.call.arguments': JSON.stringify({
        serverName: 'linear',
        toolName: 'search_issues',
        arguments: { query: 'otel' },
      }),
      'gen_ai.tool.call.result': JSON.stringify({ issues: [1, 2] }),
    });
    expect(tool.status.code).toBe(0);
  });

  it('records every OpenAI choice and scopes reconstructed tools by choice', () => {
    const exporter = init();
    const runId = 'run-openai-multi-choice';
    const turn = startTurnSpan({ runId, agentName: 'Multi Choice Parent' });
    const first = observe({
      runId,
      request: { model: 'request-model', messages: [] },
    });
    first.finish({
      status: 200,
      responseJson: {
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'choice-zero-tool',
                  function: { name: 'Read', arguments: '{"path":"a"}' },
                },
              ],
            },
          },
          {
            index: 1,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'choice-one-tool',
                  function: { name: 'Read', arguments: '{"path":"b"}' },
                },
              ],
            },
          },
        ],
      },
    });
    const second = observe({
      runId,
      request: {
        model: 'request-model',
        messages: [
          { role: 'tool', tool_call_id: 'choice-zero-tool', content: 'a' },
          { role: 'tool', tool_call_id: 'choice-one-tool', content: 'b' },
        ],
      },
    });
    second.finish({ status: 200, responseJson: { choices: [] } });
    turn.end('success');

    const spans = exporter.getFinishedSpans();
    const outputSpan = spans.find(
      (span) =>
        typeof span.attributes['gen_ai.output.messages'] === 'string' &&
        String(span.attributes['gen_ai.output.messages']).includes(
          'choice-one-tool',
        ),
    )!;
    const output = JSON.parse(
      String(outputSpan.attributes['gen_ai.output.messages']),
    ) as Array<{ index: number }>;
    expect(output.map((message) => message.index)).toEqual([0, 1]);
    expect(outputSpan.attributes['gen_ai.response.finish_reasons']).toEqual([
      'tool_calls',
      'tool_calls',
    ]);
    expect(
      toolSpans(exporter).map(
        (span) => span.attributes['gen_ai.response.choice.index'],
      ),
    ).toEqual([0, 1]);
  });

  it('settles more than 64 parallel OpenAI tool-result messages', () => {
    const exporter = init();
    const runId = 'run-openai-high-fanout';
    const turn = startTurnSpan({ runId, agentName: 'High Fanout Parent' });
    const first = observe({
      runId,
      request: { model: 'request-model', messages: [] },
    });
    first.finish({
      status: 200,
      responseJson: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: Array.from({ length: 80 }, (_, index) => ({
                id: `fanout-${index}`,
                function: {
                  name: 'Read',
                  arguments: JSON.stringify({ index }),
                },
              })),
            },
          },
        ],
      },
    });
    const second = observe({
      runId,
      request: {
        model: 'request-model',
        messages: Array.from({ length: 80 }, (_, index) => ({
          role: 'tool',
          tool_call_id: `fanout-${index}`,
          content: JSON.stringify({ index }),
        })),
      },
    });
    second.finish({ status: 200, responseJson: { choices: [] } });
    turn.end('success');

    const tools = toolSpans(exporter);
    expect(tools).toHaveLength(80);
    expect(
      tools.every(
        (span) =>
          span.attributes['gantry.tool.status'] === 'unknown' &&
          span.attributes['error.type'] === undefined,
      ),
    ).toBe(true);
  });

  it.each(['anthropic', 'openai'] as const)(
    'bounds non-streaming %s tool data before registry retention',
    (kind) => {
      const exporter = init();
      const runId = `run-bounded-${kind}-tool`;
      const turn = startTurnSpan({ runId, agentName: 'Bounded Tool Parent' });
      const upstreamUrl = kind === 'anthropic' ? MESSAGES_URL : OPENAI_URL;
      const rawId = `call-${'i'.repeat(20_000)}`;
      const rawName = `Read-${'n'.repeat(20_000)}`;
      const first = observe({
        runId,
        upstreamUrl,
        request: { model: 'request-model', messages: [] },
      });
      first.finish({
        status: 200,
        responseJson:
          kind === 'anthropic'
            ? {
                stop_reason: 'tool_use',
                content: [
                  {
                    type: 'tool_use',
                    id: rawId,
                    name: rawName,
                    input: { query: 'q'.repeat(20_000) },
                  },
                ],
              }
            : {
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          id: rawId,
                          function: {
                            name: rawName,
                            arguments: JSON.stringify({
                              query: 'q'.repeat(20_000),
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
      });
      const second = observe({
        runId,
        upstreamUrl,
        request: {
          model: 'request-model',
          messages:
            kind === 'anthropic'
              ? [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'tool_result',
                        tool_use_id: rawId,
                        content: 'done',
                      },
                    ],
                  },
                ]
              : [
                  {
                    role: 'tool',
                    tool_call_id: rawId,
                    content: 'done',
                  },
                ],
        },
      });
      second.finish({ status: 200, responseJson: {} });
      turn.end('success');

      const tool = toolSpans(exporter)[0]!;
      expect(String(tool.attributes['gen_ai.tool.call.id'])).toHaveLength(
        16_000,
      );
      expect(String(tool.attributes['gen_ai.tool.name'])).toHaveLength(16_000);
      expect(String(tool.attributes['gen_ai.tool.call.id'])).toMatch(
        /…\[truncated\]$/,
      );
      expect(
        String(tool.attributes['gen_ai.tool.call.arguments']).length,
      ).toBeLessThanOrEqual(16_000);
      expect(tool.attributes['gantry.tool.status']).toBe(
        kind === 'anthropic' ? 'success' : 'unknown',
      );
    },
  );

  it('keeps delegated children under the turn when parallel delegation is ambiguous', () => {
    const exporter = init();
    const runId = 'run-parallel-delegation';
    const turn = startTurnSpan({ runId, agentName: 'Delegation Parent' });
    const first = observe({
      runId,
      upstreamUrl: MESSAGES_URL,
      request: {
        model: 'request-model',
        messages: [{ role: 'user', content: 'Delegate twice' }],
      },
    });
    first.finish({
      status: 200,
      responseJson: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'delegate-one',
            name: 'delegate_task',
            input: { objective: 'First' },
          },
          {
            type: 'tool_use',
            id: 'delegate-two',
            name: 'delegate_task',
            input: { objective: 'Second' },
          },
        ],
      },
    });

    const delegated = createSpawnTurnTracker(
      'Ambiguous Child',
      {
        runId: 'run-ambiguous-child',
        parentRunId: runId,
        prompt: 'Do one of the queued tasks',
      },
      undefined,
    );
    delegated.finish({ status: 'success', result: 'done' });

    const second = observe({
      runId,
      upstreamUrl: MESSAGES_URL,
      request: {
        model: 'request-model',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'delegate-one',
                content: 'first done',
              },
              {
                type: 'tool_result',
                tool_use_id: 'delegate-two',
                content: 'second done',
              },
            ],
          },
        ],
      },
    });
    second.finish({
      status: 200,
      responseJson: { content: [{ type: 'text', text: 'Done' }] },
    });
    turn.end('success');

    const spans = exporter.getFinishedSpans();
    const parent = spans.find(
      (span) =>
        span.attributes['gantry.run_id'] === runId &&
        span.attributes['gen_ai.operation.name'] === 'invoke_agent',
    )!;
    const child = spans.find(
      (span) => span.attributes['gantry.run_id'] === 'run-ambiguous-child',
    )!;
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(toolSpans(exporter)).toHaveLength(2);
  });

  it('correlates parallel streamed delegations without exporting captured arguments', () => {
    const exporter = init(false);
    const runId = 'run-private-parallel-delegation';
    const turn = startTurnSpan({ runId, agentName: 'Private Delegator' });
    const observation = observe({
      runId,
      request: { model: 'request-model', stream: true, messages: [] },
    });
    const tap = observation.streamTapFor('text/event-stream')!;
    tap.transform(
      Buffer.from(
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'private-delegate-one',
                    function: {
                      name: 'delegate_task',
                      arguments: '{"objective":"Inspect alpha"}',
                    },
                  },
                  {
                    index: 1,
                    id: 'private-delegate-two',
                    function: {
                      name: 'delegate_task',
                      arguments: '{"objective":"Inspect beta"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }) + frame('[DONE]'),
      ),
    );
    tap.flush();
    observation.finish({ status: 200 });

    const alpha = createSpawnTurnTracker(
      'Alpha Inspector',
      {
        runId: 'run-private-alpha',
        parentRunId: runId,
        prompt: 'Inspect alpha',
      },
      undefined,
    );
    alpha.finish({ status: 'success', result: 'done' });
    const beta = createSpawnTurnTracker(
      'Beta Inspector',
      {
        runId: 'run-private-beta',
        parentRunId: runId,
        prompt: 'Inspect beta',
      },
      undefined,
    );
    beta.finish({ status: 'success', result: 'done' });
    turn.end('success');

    const spans = exporter.getFinishedSpans();
    const tools = toolSpans(exporter);
    const toolOne = tools.find(
      (span) =>
        span.attributes['gen_ai.tool.call.id'] === 'private-delegate-one',
    )!;
    const toolTwo = tools.find(
      (span) =>
        span.attributes['gen_ai.tool.call.id'] === 'private-delegate-two',
    )!;
    expect(
      spans.find(
        (span) => span.attributes['gantry.run_id'] === 'run-private-alpha',
      )?.parentSpanContext?.spanId,
    ).toBe(toolOne.spanContext().spanId);
    expect(
      spans.find(
        (span) => span.attributes['gantry.run_id'] === 'run-private-beta',
      )?.parentSpanContext?.spanId,
    ).toBe(toolTwo.spanContext().spanId);
    expect(toolOne.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
    expect(toolTwo.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
  });

  it('registers a streamed tool before returning its terminal SSE bytes', () => {
    const exporter = init();
    const runId = 'run-terminal-sse-race';
    const turn = startTurnSpan({ runId, agentName: 'Terminal SSE Parent' });
    const first = observe({
      runId,
      request: { model: 'request-model', stream: true, messages: [] },
    });
    const terminal = Buffer.from(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'terminal-race-call',
                  function: { name: 'Read', arguments: '{"path":"/tmp/a"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }) + frame('[DONE]'),
    );
    expect(
      first.streamTapFor('text/event-stream', 200)?.transform(terminal),
    ).toEqual(terminal);

    // Model the runner reacting as soon as it receives the terminal bytes,
    // before the first response pipeline calls finish().
    const second = observe({
      runId,
      request: {
        model: 'request-model',
        messages: [
          {
            role: 'tool',
            tool_call_id: 'terminal-race-call',
            content: 'read result',
          },
        ],
      },
    });
    second.finish({ status: 200, responseJson: { choices: [] } });
    first.finish({ status: 200 });
    turn.end('success');

    const tools = toolSpans(exporter);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.attributes).toMatchObject({
      'gen_ai.tool.call.id': 'terminal-race-call',
      'gantry.tool.status': 'unknown',
      'gen_ai.tool.call.result': 'read result',
    });
  });

  it('pairs oversized streamed tool IDs with canonically bounded results', () => {
    const exporter = init();
    const runId = 'run-oversized-stream-id';
    const rawId = `stream-${'i'.repeat(20_000)}`;
    const turn = startTurnSpan({ runId, agentName: 'Bounded Stream Parent' });
    const first = observe({
      runId,
      request: { model: 'request-model', stream: true, messages: [] },
    });
    first.streamTapFor('text/event-stream', 200)?.transform(
      Buffer.from(
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: rawId,
                    function: { name: 'Read', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }) + frame('[DONE]'),
      ),
    );
    const second = observe({
      runId,
      request: {
        model: 'request-model',
        messages: [
          { role: 'tool', tool_call_id: rawId, content: 'stream result' },
        ],
      },
    });
    second.finish({ status: 200, responseJson: { choices: [] } });
    first.finish({ status: 200 });
    turn.end('success');

    const tool = toolSpans(exporter)[0]!;
    expect(String(tool.attributes['gen_ai.tool.call.id'])).toHaveLength(16_000);
    expect(tool.attributes).toMatchObject({
      'gantry.tool.status': 'unknown',
      'gen_ai.tool.call.result': 'stream result',
    });
  });

  it('keeps tool identity, transport, timing, and status when capture is disabled', () => {
    const exporter = init(false);
    const runId = 'run-private-tool';
    const turn = startTurnSpan({ runId, agentName: 'Private Tool Parent' });
    const first = observe({
      runId,
      request: { model: 'request-model', messages: [] },
    });
    first.finish({
      status: 200,
      responseJson: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  id: 'private-call',
                  function: {
                    name: 'Write',
                    arguments: '{"secret":"argument"}',
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const second = observe({
      runId,
      request: {
        model: 'request-model',
        messages: [
          {
            role: 'tool',
            tool_call_id: 'private-call',
            content: '{"secret":"result"}',
          },
        ],
      },
    });
    second.finish({ status: 200, responseJson: { choices: [] } });
    turn.end('success');

    const tool = toolSpans(exporter)[0]!;
    expect(tool.attributes).toMatchObject({
      'gen_ai.tool.name': 'Write',
      'gen_ai.tool.call.id': 'private-call',
      'gantry.tool.transport': 'local',
      'gantry.tool.status': 'unknown',
      'gantry.tool.timing': 'reconstructed',
      'gantry.tool.latency_ms': expect.any(Number),
    });
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
    expect(tool.attributes['gen_ai.tool.call.result']).toBeUndefined();
    expect(tool.status.code).toBe(0);
  });

  it('keeps truncated structured tool arguments and results valid JSON', () => {
    const exporter = init();
    const runId = 'run-large-tool-payload';
    const turn = startTurnSpan({ runId, agentName: 'Large Tool Parent' });
    const first = observe({
      runId,
      request: { model: 'request-model', messages: [] },
    });
    first.finish({
      status: 200,
      responseJson: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  id: 'large-call',
                  function: {
                    name: 'Search',
                    arguments: JSON.stringify({ query: 'x'.repeat(20_000) }),
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const second = observe({
      runId,
      request: {
        model: 'request-model',
        messages: [
          {
            role: 'tool',
            tool_call_id: 'large-call',
            content: JSON.stringify({ output: 'y'.repeat(20_000) }),
          },
        ],
      },
    });
    second.finish({ status: 200, responseJson: { choices: [] } });
    turn.end('success');

    const attributes = toolSpans(exporter)[0]!.attributes;
    const args = String(attributes['gen_ai.tool.call.arguments']);
    const result = String(attributes['gen_ai.tool.call.result']);
    expect(args.length).toBeLessThanOrEqual(16_000);
    expect(result.length).toBeLessThanOrEqual(16_000);
    expect(JSON.parse(args)).toMatchObject({
      query: expect.stringMatching(/…\[truncated\]$/),
    });
    expect(JSON.parse(result)).toMatchObject({
      output: expect.stringMatching(/…\[truncated\]$/),
    });
  });

  it('does not reconstruct tool spans after the turn has already ended', () => {
    const exporter = init();
    const runId = 'run-ended-before-response';
    const turn = startTurnSpan({ runId, agentName: 'Cancelled Tool Parent' });
    const observation = observe({
      runId,
      upstreamUrl: MESSAGES_URL,
      request: { model: 'request-model', messages: [] },
    });
    turn.end('cancelled');
    observation.finish({
      status: 200,
      responseJson: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'late-tool',
            name: 'Read',
            input: { path: '/tmp/late' },
          },
        ],
      },
    });

    const restartedTurn = startTurnSpan({
      runId,
      agentName: 'Restarted Tool Parent',
    });
    const followUp = observe({
      runId,
      upstreamUrl: MESSAGES_URL,
      request: {
        model: 'request-model',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'late-tool',
                content: 'late result',
              },
            ],
          },
        ],
      },
    });
    followUp.finish({ status: 200, responseJson: {} });
    restartedTurn.end('success');

    expect(toolSpans(exporter)).toHaveLength(0);
  });

  it.each([
    [
      'provider stream error',
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'phantom-tool',
                  function: { name: 'Read', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }) + frame({ error: { message: 'stream failed' } }),
    ],
    [
      'incomplete stream',
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'phantom-tool',
                  function: { name: 'Read', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    ],
  ])('does not reconstruct tool spans from a %s', (_scenario, stream) => {
    const exporter = init();
    const runId = `run-${_scenario.replaceAll(' ', '-')}`;
    const turn = startTurnSpan({ runId, agentName: 'Streaming Tool Parent' });
    const observation = observe({
      runId,
      request: { model: 'request-model', stream: true, messages: [] },
    });
    const tap = observation.streamTapFor('text/event-stream')!;
    tap.transform(Buffer.from(stream));
    tap.flush();
    observation.finish({ status: 200 });
    turn.end('success');

    expect(toolSpans(exporter)).toHaveLength(0);
  });

  it('suppresses schema-incomplete current output messages but keeps legacy content', () => {
    const exporter = init();
    const observation = observe({
      request: { model: 'request-model', stream: true, messages: [] },
    });
    const tap = observation.streamTapFor('text/event-stream')!;
    tap.transform(
      Buffer.from(
        frame({ choices: [{ delta: { content: 'partial output' } }] }),
      ),
    );
    tap.flush();
    observation.finish({ status: 200 });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes['gen_ai.completion']).toBe(
      JSON.stringify([{ role: 'assistant', content: 'partial output' }]),
    );
    expect(attributes['gen_ai.output.messages']).toBeUndefined();
  });

  it('does not assign one streamed choice finish reason to an incomplete choice', () => {
    const exporter = init();
    const observation = observe({
      request: { model: 'request-model', stream: true, messages: [] },
    });
    const tap = observation.streamTapFor('text/event-stream')!;
    tap.transform(
      Buffer.from(
        frame({
          choices: [
            {
              index: 0,
              delta: { content: 'complete choice' },
              finish_reason: 'stop',
            },
            {
              index: 1,
              delta: { content: 'partial choice' },
              finish_reason: null,
            },
          ],
        }),
      ),
    );
    tap.flush();
    observation.finish({ status: 200 });

    const attributes = chatSpan(exporter).attributes;
    expect(String(attributes['gen_ai.completion'])).toContain(
      'complete choice',
    );
    expect(String(attributes['gen_ai.completion'])).toContain('partial choice');
    expect(attributes['gen_ai.output.messages']).toBeUndefined();
  });

  it('ends an unmatched reconstructed tool span when its turn ends', () => {
    const exporter = init(false);
    const runId = 'run-unmatched-tool';
    const turn = startTurnSpan({ runId, agentName: 'Interrupted Tool Parent' });
    const observation = observe({
      runId,
      upstreamUrl: MESSAGES_URL,
      request: { model: 'request-model', messages: [] },
    });
    observation.finish({
      status: 200,
      responseJson: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'unmatched-tool',
            name: 'Read',
            input: { path: '/tmp/a' },
          },
        ],
      },
    });

    turn.end('error', 'tool execution interrupted');

    const tool = toolSpans(exporter)[0]!;
    expect(tool.attributes).toMatchObject({
      'gen_ai.tool.name': 'Read',
      'gantry.tool.transport': 'local',
      'gantry.tool.status': 'error',
      'gantry.tool.latency_ms': expect.any(Number),
      'error.type': 'tool_result_missing',
    });
    expect(tool.status.code).toBe(2);
  });

  it('keeps token attributes but omits content when capture is disabled', () => {
    const exporter = init(false);
    const observation = observe({
      request: {
        model: 'request-model',
        messages: [{ role: 'user', content: 'private prompt' }],
      },
    });

    observation.finish({
      status: 200,
      responseJson: {
        choices: [{ message: { content: 'private completion' } }],
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      },
    });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes['gen_ai.prompt']).toBeUndefined();
    expect(attributes['gen_ai.completion']).toBeUndefined();
    expect(attributes['gen_ai.usage.input_tokens']).toBe(8);
    expect(attributes['gen_ai.usage.output_tokens']).toBe(3);
  });

  it('augments raw usage with canonical normalized cache attributes', () => {
    const exporter = init();
    const observation = observe({
      upstreamUrl: MESSAGES_URL,
      request: { model: 'request-model', messages: [] },
    });

    observation.finish({
      status: 200,
      responseJson: {
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      normalizedUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        totalBillableInputTokens: 60,
        estimatedCostUsd: 0.001,
        cacheProvider: 'anthropic',
        cacheStatus: 'partial',
        at: '2026-07-14T00:00:00.000Z',
      },
    });

    expect(chatSpan(exporter).attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 150,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read_input_tokens': 40,
      'gen_ai.usage.cache_creation_input_tokens': 10,
      'gen_ai.usage.cost': 0.001,
    });
  });

  it('bounds captured prompt and completion messages over 16k characters', () => {
    const exporter = init();
    const oversized = 'x'.repeat(17_000);
    const observation = observe({
      request: {
        model: 'request-model',
        messages: [{ role: 'user', content: oversized }],
      },
    });

    observation.finish({
      status: 200,
      responseJson: {
        choices: [{ message: { content: oversized } }],
      },
    });

    const attributes = chatSpan(exporter).attributes;
    const prompt = JSON.parse(String(attributes['gen_ai.prompt'])) as {
      content: string;
    }[];
    const completion = JSON.parse(String(attributes['gen_ai.completion'])) as {
      content: string;
    }[];
    expect(prompt[0]?.content).toHaveLength(16_012);
    expect(completion[0]?.content).toHaveLength(16_012);
    expect(prompt[0]?.content).toMatch(/…\[truncated\]$/);
    expect(completion[0]?.content).toMatch(/…\[truncated\]$/);
  });

  it('keeps current output schema valid in the message overflow fallback', () => {
    const exporter = init();
    const wideChild = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `child-${index}`,
        'x'.repeat(1_000),
      ]),
    );
    const widePayload = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`branch-${index}`, wideChild]),
    );
    const observation = observe({
      upstreamUrl: MESSAGES_URL,
      request: { model: 'request-model', messages: [] },
    });

    observation.finish({
      status: 200,
      responseJson: {
        stop_reason: 'end_turn',
        content: [{ type: 'provider_payload', payload: widePayload }],
      },
    });

    expect(
      JSON.parse(
        String(chatSpan(exporter).attributes['gen_ai.output.messages']),
      ),
    ).toEqual([
      {
        role: 'unknown',
        parts: [{ type: 'text', content: '…[truncated]' }],
        finish_reason: 'end_turn',
      },
    ]);
  });

  it('marks truncated all-text Anthropic completions explicitly', () => {
    const exporter = init();
    const observation = observe({
      upstreamUrl: MESSAGES_URL,
      request: { model: 'request-model', messages: [] },
    });
    observation.finish({
      status: 200,
      responseJson: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'x'.repeat(20_000) }],
      },
    });

    const attributes = chatSpan(exporter).attributes;
    const legacy = JSON.parse(
      String(attributes['gen_ai.completion']),
    ) as Array<{
      content: string;
    }>;
    const current = JSON.parse(
      String(attributes['gen_ai.output.messages']),
    ) as Array<{ parts: Array<{ content: string }> }>;
    expect(legacy[0]?.content).toMatch(/…\[truncated\]$/);
    expect(current[0]?.parts[0]?.content).toMatch(/…\[truncated\]$/);
  });

  it('keeps oversized multi-message prompts valid within the attribute cap', () => {
    const exporter = init();
    const oversized = 'x'.repeat(17_000);
    const observation = observe({
      request: {
        model: 'request-model',
        messages: [
          { role: 'user', content: oversized },
          { role: 'assistant', content: oversized },
          { role: 'user', content: oversized },
        ],
      },
    });

    observation.finish({ status: 200, responseJson: {} });

    const prompt = String(chatSpan(exporter).attributes['gen_ai.prompt']);
    expect(prompt.length).toBeLessThanOrEqual(32_768);
    expect(JSON.parse(prompt)).toMatchObject([
      { role: 'user', content: expect.stringMatching(/…\[truncated\]$/) },
      { role: 'assistant', content: expect.stringMatching(/…\[truncated\]$/) },
      { role: 'user', content: expect.stringMatching(/…\[truncated\]$/) },
    ]);
  });

  it('releases all bytes and degrades to pass-through on a giant unterminated frame', () => {
    init();
    const observation = observe({
      providerId: 'openai',
      request: {
        model: 'request-model',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const tap = observation.streamTapFor('text/event-stream')!;
    const giant = Buffer.from(`data: {"x":"${'a'.repeat(1_100_000)}`, 'utf8');
    const after = Buffer.from('tail-bytes', 'utf8');

    const released = tap.transform(giant);
    expect(released.toString('utf8')).toBe(giant.toString('utf8'));
    expect(tap.transform(after)).toBe(after);
    expect(tap.flush()).toEqual(Buffer.alloc(0));
  });

  it('injects include_usage and strips only the synthetic usage frame', () => {
    const exporter = init();
    const observation = observe({
      providerId: 'openai',
      request: {
        model: 'request-model',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const forwarded = JSON.parse(observation.requestBody.toString('utf8')) as {
      stream_options?: { include_usage?: boolean };
    };
    expect(forwarded.stream_options?.include_usage).toBe(true);

    const contentChunk = Buffer.from(
      frame({
        model: 'response-model',
        choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
      }),
    );
    const usageChunk = Buffer.from(
      frame({
        model: 'response-model',
        choices: [],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      }),
    );
    expect(
      observation
        .streamTapFor('text/event-stream')
        ?.transform(contentChunk)
        .toString(),
    ).toBe(contentChunk.toString());
    expect(
      observation.streamTapFor('text/event-stream')?.transform(usageChunk),
    ).toEqual(Buffer.alloc(0));
    observation
      .streamTapFor('text/event-stream')
      ?.transform(Buffer.from(frame('[DONE]')));
    observation.finish({ status: 200 });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes).toMatchObject({
      'gen_ai.response.model': 'response-model',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 5,
      'gen_ai.usage.output_tokens': 1,
      'gen_ai.usage.cached_tokens': 2,
    });
    expect(JSON.parse(String(attributes['gen_ai.completion']))).toEqual([
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  it('accumulates and strips a delimiter-less terminal usage-only frame', () => {
    const exporter = init();
    const observation = observe({
      request: {
        model: 'request-model',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    observation.streamTapFor('text/event-stream')?.transform(
      Buffer.from(
        'data: ' +
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 3 },
            },
          }),
      ),
    );

    expect(observation.streamTapFor('text/event-stream')?.flush()).toEqual(
      Buffer.alloc(0),
    );
    observation.finish({ status: 200 });

    expect(chatSpan(exporter).attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 7,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.cached_tokens': 3,
    });
  });

  it.each([true, false])(
    'preserves caller include_usage=%s bodies and frames byte-for-byte',
    (includeUsage) => {
      init();
      const body = Buffer.from(
        JSON.stringify({
          model: 'request-model',
          stream: true,
          stream_options: { include_usage: includeUsage },
        }),
      );
      const observation = observeGatewayCall({
        token: {},
        providerId: 'fixture-provider',
        upstreamUrl: OPENAI_URL,
        requestBody: body,
      });
      expect(observation).toBeDefined();
      expect(observation?.requestBody).toBe(body);

      const usageFrame = Buffer.from(
        frame({ choices: [], usage: { prompt_tokens: 2 } }),
      );
      expect(
        observation?.streamTapFor('text/event-stream')?.transform(usageFrame),
      ).toBe(usageFrame);
      observation?.finish({ status: 200 });
    },
  );

  it('drains delimiter-less terminal usage after byte pass-through', () => {
    const exporter = init();
    const observation = observe({
      request: {
        model: 'request-model',
        stream: true,
        stream_options: { include_usage: true },
      },
    });
    const usageFrame = Buffer.from(
      'data: ' +
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 6, completion_tokens: 2 },
        }),
    );

    expect(
      observation.streamTapFor('text/event-stream')?.transform(usageFrame),
    ).toBe(usageFrame);
    expect(observation.streamTapFor('text/event-stream')?.flush()).toEqual(
      Buffer.alloc(0),
    );
    observation.finish({ status: 200 });

    expect(chatSpan(exporter).attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 6,
      'gen_ai.usage.output_tokens': 2,
    });
  });

  it('omits token attributes when an OpenAI stream has no usage chunk', () => {
    const exporter = init();
    const observation = observe({
      request: {
        model: 'request-model',
        stream: true,
        stream_options: { include_usage: true },
      },
    });
    observation.streamTapFor('text/event-stream')?.transform(
      Buffer.from(
        frame({
          choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
        }) + frame('[DONE]'),
      ),
    );
    observation.finish({ status: 200 });

    const attributes = chatSpan(exporter).attributes;
    expect(attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(attributes['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(attributes['gen_ai.usage.total_tokens']).toBeUndefined();
  });

  it('does nothing when tracing is disabled', () => {
    expect(
      observeGatewayCall({
        token: {},
        providerId: 'fixture-provider',
        upstreamUrl: OPENAI_URL,
        requestBody: Buffer.from('{}'),
      }),
    ).toBeUndefined();
  });
});

describe('SSE accumulation', () => {
  it('accumulates Anthropic CRLF frames through DONE', () => {
    const accumulator = createSseAccumulator('anthropic', true);
    accumulator.push(
      Buffer.from(
        [
          frame(
            {
              type: 'message_start',
              message: {
                model: 'response-model',
                usage: { input_tokens: 11, cache_read_input_tokens: 4 },
              },
            },
            '\r\n',
          ),
          frame(
            {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'Hello ' },
            },
            '\r\n',
          ),
          frame(
            {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'world' },
            },
            '\r\n',
          ),
          frame(
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 2 },
            },
            '\r\n',
          ),
          frame('[DONE]', '\r\n'),
          frame(
            {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: ' ignored' },
            },
            '\r\n',
          ),
        ].join(''),
      ),
    );

    expect(accumulator.result()).toEqual({
      model: 'response-model',
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: 4,
        output_tokens: 2,
      },
      completionText: 'Hello world',
      finishReason: 'end_turn',
    });
  });

  it('accumulates OpenAI streams with and without usage', () => {
    const withUsage = createSseAccumulator('openai', true);
    withUsage.push(
      Buffer.from(
        frame({
          model: 'response-model',
          choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
        }) +
          frame({
            model: 'response-model',
            choices: [{ delta: {}, finish_reason: 'stop' }],
          }) +
          frame({
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          }),
      ),
    );
    expect(withUsage.result()).toEqual({
      model: 'response-model',
      usage: { prompt_tokens: 5, completion_tokens: 1 },
      completionText: 'Hi',
      finishReason: 'stop',
    });

    const withoutUsage = createSseAccumulator('openai', true);
    withoutUsage.push(
      Buffer.from(
        frame({
          model: 'response-model',
          choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
        }) + frame('[DONE]'),
      ),
    );
    expect(withoutUsage.result()).toEqual({
      model: 'response-model',
      completionText: 'Hi',
      finishReason: 'stop',
    });

    const refusal = createSseAccumulator('openai', true);
    refusal.push(
      Buffer.from(
        frame({
          choices: [
            { delta: { refusal: 'Cannot comply' }, finish_reason: 'stop' },
          ],
        }),
      ),
    );
    expect(refusal.result()).toEqual({
      assistantMessage: {
        role: 'assistant',
        content: null,
        index: 0,
        finish_reason: 'stop',
        refusal: 'Cannot comply',
        tool_calls: [],
      },
      finishReason: 'stop',
    });
  });

  it('keeps OpenAI streaming choices and tool fragments isolated by choice index', () => {
    const accumulator = createSseAccumulator('openai', true);
    accumulator.push(
      Buffer.from(
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-a',
                    function: { name: 'Read', arguments: '{"path":' },
                  },
                ],
              },
              finish_reason: null,
            },
            {
              index: 1,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-b',
                    function: { name: 'Search', arguments: '{"query":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) +
          frame({
            choices: [
              {
                index: 1,
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '"trace"}' } },
                  ],
                },
                finish_reason: 'stop',
              },
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '"/tmp/a"}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
      ),
    );

    expect(accumulator.result()).toMatchObject({
      finishReasons: ['tool_calls', 'stop'],
      toolCalls: [
        {
          id: 'call-a',
          name: 'Read',
          arguments: { path: '/tmp/a' },
          choiceIndex: 0,
          complete: true,
        },
        {
          id: 'call-b',
          name: 'Search',
          arguments: { query: 'trace' },
          choiceIndex: 1,
          complete: false,
        },
      ],
      assistantMessages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-a',
              function: { name: 'Read', arguments: { path: '/tmp/a' } },
            },
          ],
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-b',
              function: { name: 'Search', arguments: { query: 'trace' } },
            },
          ],
        },
      ],
    });
  });

  it('bounds distinct OpenAI stream choices and their aggregate content across frames', () => {
    const accumulator = createSseAccumulator('openai', true);
    for (let index = 0; index < 180; index += 1) {
      accumulator.push(
        Buffer.from(
          frame({
            choices: [
              {
                index,
                delta: { content: 'x'.repeat(4_096) },
                finish_reason: 'stop',
              },
            ],
          }),
        ),
      );
    }

    const result = accumulator.result();
    expect(result.finishReasons).toHaveLength(128);
    expect(result.assistantMessages).toHaveLength(64);
    const retainedChars = result.assistantMessages!.reduce(
      (total, message) =>
        total +
        (typeof message.content === 'string' ? message.content.length : 0),
      0,
    );
    expect(retainedChars).toBe(256 * 1024);
    expect(result.assistantMessages?.at(-1)).toMatchObject({
      index: 63,
      finish_reason: 'stop',
    });
  });

  it('retains Anthropic and OpenAI streaming tool identities and structured arguments', () => {
    const anthropic = createSseAccumulator('anthropic', true);
    anthropic.push(
      Buffer.from(
        frame({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'anthropic-tool',
            name: 'Read',
            input: {},
          },
        }) +
          frame({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":' },
          }) +
          frame({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '"/tmp/a"}' },
          }),
      ),
    );
    expect(anthropic.result()).toMatchObject({
      toolCalls: [
        {
          id: 'anthropic-tool',
          name: 'Read',
          arguments: { path: '/tmp/a' },
        },
      ],
      assistantMessage: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'anthropic-tool',
            name: 'Read',
            input: { path: '/tmp/a' },
          },
        ],
      },
    });

    const openai = createSseAccumulator('openai', true);
    openai.push(
      Buffer.from(
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_',
                    function: { name: 'mcp_', arguments: '{"serverName":' },
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
                      id: 'stream',
                      function: { name: 'call_tool', arguments: '"github"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
      ),
    );
    expect(openai.result()).toMatchObject({
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'call_stream',
          name: 'mcp_call_tool',
          arguments: { serverName: 'github' },
        },
      ],
      assistantMessage: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_stream',
            function: {
              name: 'mcp_call_tool',
              arguments: { serverName: 'github' },
            },
          },
        ],
      },
    });
  });

  it('retains streaming tool identity but drops arguments when capture is disabled', () => {
    const accumulator = createSseAccumulator('openai', false);
    accumulator.push(
      Buffer.from(
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'private-id',
                    function: {
                      name: 'mcp_call_tool',
                      arguments: '{"serverName":"private-mcp","secret":true}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    );
    expect(accumulator.result()).toEqual({
      toolCalls: [
        {
          id: 'private-id',
          name: 'mcp_call_tool',
          mcpServer: 'private-mcp',
          choiceIndex: 0,
          complete: true,
        },
      ],
      finishReason: 'tool_calls',
    });
  });

  it('parses large streamed tool arguments before structurally bounding them', () => {
    const accumulator = createSseAccumulator('openai', true);
    accumulator.push(
      Buffer.from(
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'large-streamed-tool',
                    function: {
                      name: 'mcp_call_tool',
                      arguments: JSON.stringify({
                        serverName: 'github',
                        query: 'x'.repeat(20_000),
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    );

    const result = accumulator.result();
    const args = result.toolCalls?.[0]?.arguments as
      | Record<string, unknown>
      | undefined;
    expect(result.toolCalls?.[0]?.mcpServer).toBe('github');
    expect(args?.serverName).toBe('github');
    expect(args?.query).toEqual(expect.stringMatching(/…\[truncated\]$/));
    expect(JSON.stringify(args).length).toBeLessThanOrEqual(16 * 1024);
  });

  it('shares one bounded raw-argument budget across streamed tool calls', () => {
    const accumulator = createSseAccumulator('openai', true);
    for (let index = 0; index < 3; index += 1) {
      accumulator.push(
        Buffer.from(
          frame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: `aggregate-${index}`,
                      function: {
                        name: 'Search',
                        arguments: JSON.stringify({
                          query: String(index).repeat(400_000),
                        }),
                      },
                    },
                  ],
                },
                finish_reason: index === 2 ? 'tool_calls' : null,
              },
            ],
          }),
        ),
      );
    }

    const calls = accumulator.result().toolCalls!;
    expect(calls).toHaveLength(3);
    expect(typeof calls[0]?.arguments).toBe('object');
    expect(typeof calls[1]?.arguments).toBe('object');
    expect(calls[2]?.arguments).toEqual(
      expect.stringMatching(/…\[truncated\]$/),
    );
  });

  it('stops after malformed data without throwing or losing prior data', () => {
    const accumulator = createSseAccumulator('openai', true);
    expect(() => {
      accumulator.push(
        Buffer.from(
          frame({
            model: 'response-model',
            choices: [{ delta: { content: 'kept' } }],
          }) +
            frame('{not json') +
            frame({ choices: [{ delta: { content: ' ignored' } }] }),
        ),
      );
    }).not.toThrow();
    expect(accumulator.result()).toEqual({
      model: 'response-model',
      completionText: 'kept',
    });
  });

  it('splits CRLF frames and detects only usage-only OpenAI frames', () => {
    const splitter = createSseFrameSplitter();
    expect(splitter.push(Buffer.from('data: one\r\n\r\ndata: tw'))).toEqual([
      'data: one',
    ]);
    expect(splitter.push(Buffer.from('o\r\n\r\n'))).toEqual(['data: two']);
    expect(splitter.flush()).toEqual([]);

    expect(
      isOpenAiUsageOnlyFrame(
        'data: {"choices":[],"usage":{"prompt_tokens":1}}',
      ),
    ).toBe(true);
    expect(
      isOpenAiUsageOnlyFrame(
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1}}',
      ),
    ).toBe(false);
    expect(isOpenAiUsageOnlyFrame('data: [DONE]')).toBe(false);
  });
});
