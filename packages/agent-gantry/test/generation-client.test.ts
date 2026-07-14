import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const langfuseContextMock = vi.hoisted(() => ({
  traceId: undefined as string | undefined,
  spanId: undefined as string | undefined,
}));

vi.mock('@langfuse/tracing', () => ({
  getActiveTraceId: () => langfuseContextMock.traceId,
  getActiveSpanId: () => langfuseContextMock.spanId,
}));

import {
  GantryGenerationError,
  createGantryGenerationClient,
  isRetryableGantryGenerationError,
} from '../src/generation-client.js';

describe('GantryGenerationClient', () => {
  it('resolves the model outside the call and sends Claude text then image', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('anthropic-version')).toBe(
        '2023-06-01',
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe('sonnet-4.6');
      expect(body.system).toBe('Stable system');
      expect(body.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Unique content' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: Buffer.from('image').toString('base64'),
              },
            },
          ],
        },
      ]);
      return new Response(
        JSON.stringify({
          id: 'msg-1',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 1,
          },
        }),
        { status: 200 },
      );
    });
    const client = createGantryGenerationClient({
      baseUrl: 'http://gantry.test',
      apiKey: 'secret',
      resolveOperation: () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await client.invokeGeneration({
      operationName: 'test.claude',
      system: 'Stable system',
      content: {
        text: 'Unique content',
        images: [
          {
            mimeType: 'image/png',
            base64: Buffer.from('image').toString('base64'),
          },
        ],
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: '{"ok":true}',
      responseId: 'msg-1',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 20,
        cacheReadInputTokens: 7,
        cacheCreationInputTokens: 1,
      },
    });
  });

  it('reads local images before sending Gemini chat completions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gantry-generation-'));
    const localPath = join(directory, 'screen.png');
    await writeFile(localPath, Buffer.from('screen'));
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://gantry.test/llm/v1/chat/completions');
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(body.messages[0]).toEqual({
        role: 'system',
        content: 'Stable system',
      });
      expect(body.messages[1]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'Unique content' },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${Buffer.from('screen').toString('base64')}`,
            },
          },
        ],
      });
      return new Response(
        JSON.stringify({
          id: 'gemini-1',
          choices: [{ message: { role: 'assistant', content: 'done' } }],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 1,
            total_tokens: 9,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        }),
        { status: 200 },
      );
    });
    const client = createGantryGenerationClient({
      baseUrl: 'http://gantry.test',
      apiKey: 'secret',
      resolveOperation: () => ({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      }),
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await client.invokeGeneration({
      operationName: 'test.gemini',
      system: 'Stable system',
      content: { text: 'Unique content', images: [{ localPath }] },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.usage.cacheReadInputTokens).toBe(4);
    expect(result.usage.inputTokens).toBe(4);
    expect(result.usage.totalTokens).toBe(9);
  });

  it('forwards active Langfuse parent context only in the Gantry observability header', async () => {
    langfuseContextMock.traceId = 'a'.repeat(32);
    langfuseContextMock.spanId = 'b'.repeat(16);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const encoded = headers.get('x-gantry-observability-context');
      expect(encoded).toBeTruthy();
      const context = JSON.parse(
        Buffer.from(encoded!, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      expect(context).toMatchObject({
        parentTraceId: 'a'.repeat(32),
        parentSpanId: 'b'.repeat(16),
        operationName: 'test.parented',
      });
      expect(String(init?.body)).not.toContain('parentTraceId');
      expect(String(init?.body)).not.toContain('parentSpanId');
      return new Response(
        JSON.stringify({
          id: 'chat-parented',
          choices: [{ message: { content: 'done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    });
    const client = createGantryGenerationClient({
      baseUrl: 'http://gantry.test',
      apiKey: 'secret',
      resolveOperation: () => ({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      }),
      fetchImpl: fetchImpl as typeof fetch,
    });

    try {
      await client.invokeGeneration({
        operationName: 'test.parented',
        system: 'Stable',
        content: { text: 'Unique' },
      });
    } finally {
      langfuseContextMock.traceId = undefined;
      langfuseContextMock.spanId = undefined;
    }
  });

  it('ignores malformed active trace context without blocking generation', async () => {
    langfuseContextMock.traceId = 'invalid';
    langfuseContextMock.spanId = 'also-invalid';
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(
        new Headers(init?.headers).get('x-gantry-observability-context'),
      ).toBeNull();
      return new Response(
        JSON.stringify({
          id: 'chat-standalone',
          choices: [{ message: { content: 'done' } }],
        }),
        { status: 200 },
      );
    });
    const client = createGantryGenerationClient({
      baseUrl: 'http://gantry.test',
      apiKey: 'secret',
      resolveOperation: () => ({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      }),
      fetchImpl: fetchImpl as typeof fetch,
    });

    try {
      await client.invokeGeneration({
        operationName: 'test.malformed-parent',
        system: 'Stable',
        content: { text: 'Unique' },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      langfuseContextMock.traceId = undefined;
      langfuseContextMock.spanId = undefined;
    }
  });

  it('sends Anthropic structured output without an unsupported schema name', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        output_config?: { format?: Record<string, unknown> };
      };
      expect(body.output_config?.format).toEqual({
        type: 'json_schema',
        schema: { type: 'object' },
      });
      return new Response(
        JSON.stringify({
          id: 'msg-structured',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    });
    const client = createGantryGenerationClient({
      baseUrl: 'http://gantry.test',
      apiKey: 'secret',
      resolveOperation: () => ({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.invokeGeneration({
      operationName: 'test.claude.structured',
      system: 'Stable system',
      content: { text: 'Unique content' },
      responseFormat: {
        type: 'json_schema',
        name: 'answer',
        schema: { type: 'object' },
      },
    });
  });

  it('marks the stable Anthropic system prefix with requested prompt cache TTL', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.system).toEqual([
        {
          type: 'text',
          text: 'Stable cacheable system',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]);
      expect(JSON.stringify(body.messages)).not.toContain('cache_control');
      return new Response(
        JSON.stringify({
          id: 'msg-cache',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_creation_input_tokens: 4,
          },
        }),
        { status: 200 },
      );
    });
    const client = createGantryGenerationClient({
      baseUrl: 'http://gantry.test',
      apiKey: 'secret',
      resolveOperation: () => ({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.invokeGeneration({
      operationName: 'test.claude.cache',
      system: 'Stable cacheable system',
      content: { text: 'Dynamic request body' },
      promptCache: { ttl: '1h' },
    });
  });

  it('performs one request and exposes retryable status without retrying', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'MODEL_GATEWAY_UNAVAILABLE',
              message: 'Unavailable',
            },
          }),
          { status: 503, headers: { 'retry-after': '2' } },
        ),
    );
    const client = createGantryGenerationClient({
      baseUrl: 'http://gantry.test',
      apiKey: 'secret',
      resolveOperation: () => ({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      }),
      fetchImpl: fetchImpl as typeof fetch,
    });

    const error = await client
      .invokeGeneration({
        operationName: 'test.retry',
        system: 'Stable',
        content: { text: 'Unique' },
      })
      .catch((caught: unknown) => caught);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(GantryGenerationError);
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'MODEL_GATEWAY_UNAVAILABLE',
      retryAfterMs: 2000,
    });
    expect(isRetryableGantryGenerationError(error)).toBe(true);
  });

  it('does not classify invalid requests as retryable', () => {
    expect(
      isRetryableGantryGenerationError(
        new GantryGenerationError({ message: 'invalid', statusCode: 400 }),
      ),
    ).toBe(false);
  });

  it('allows independent generation requests to run concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response(
        JSON.stringify({
          id: 'chat-1',
          choices: [{ message: { content: 'done' } }],
        }),
        { status: 200 },
      );
    });
    const client = createGantryGenerationClient({
      baseUrl: 'http://gantry.test',
      apiKey: 'secret',
      resolveOperation: () => ({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      }),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        client.invokeGeneration({
          operationName: `test.concurrent.${index}`,
          system: 'Stable',
          content: { text: `Unique ${index}` },
        }),
      ),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(3);
  });
});
