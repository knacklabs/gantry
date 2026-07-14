import { describe, expect, it } from 'vitest';

import {
  DirectLlmResponseInspector,
  readDirectLlmObservationContext,
  summarizeDirectLlmInput,
} from '../../../src/control/server/routes/llm-observability.js';

describe('direct LLM observability helpers', () => {
  it('reads workflow context without exposing image content', () => {
    const value = Buffer.from(
      JSON.stringify({
        operationName: 'solveCaptcha',
        modelCallType: 'ocr',
        attempt: 2,
        sessionId: 'scrape_run:run-1',
        costCategory: 'captcha',
        costStage: 'captcha.solve',
        serviceName: 'platform-worker',
        parentTraceId: 'a'.repeat(32),
        parentSpanId: 'b'.repeat(16),
        metadata: { run_id: 'run-1', task_id: 'task-1' },
        imageMetadata: [{ mime_type: 'image/png', bytes: 5, sha256: 'hash' }],
      }),
    ).toString('base64url');

    expect(
      readDirectLlmObservationContext({
        'x-gantry-observability-context': value,
      }),
    ).toMatchObject({
      operationName: 'solveCaptcha',
      modelCallType: 'ocr',
      attempt: 2,
      parentSpanContext: {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
      },
      observability: {
        sessionId: 'scrape_run:run-1',
        costCategory: 'captcha',
        costStage: 'captcha.solve',
      },
      metadata: {
        run_id: 'run-1',
        task_id: 'task-1',
        service_name: 'platform-worker',
        image_metadata: [{ mime_type: 'image/png', bytes: 5, sha256: 'hash' }],
      },
    });
  });

  it('extracts Anthropic usage and summarizes images without raw base64', () => {
    const inspector = new DirectLlmResponseInspector('application/json');
    inspector.inspect(
      Buffer.from(
        JSON.stringify({
          id: 'msg-1',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 20,
          },
        }),
      ),
    );

    expect(inspector.finish(200)).toEqual({
      statusCode: 200,
      responseId: 'msg-1',
      outputPreview: '{"ok":true}',
      usageDetails: {
        input: 100,
        output: 10,
        total: 210,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    });

    const summary = summarizeDirectLlmInput(
      Buffer.from(
        JSON.stringify({
          system: 'Stable',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Unique' },
                {
                  type: 'image',
                  source: { type: 'base64', data: 'RAW_IMAGE_DATA' },
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(summary).toMatchObject({ image_count: 1, message_count: 1 });
    expect(JSON.stringify(summary)).not.toContain('RAW_IMAGE_DATA');
  });

  it('records provider errors with zero usage instead of estimated paid tokens', () => {
    const inspector = new DirectLlmResponseInspector('application/json');
    inspector.inspect(
      Buffer.from(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'credit unavailable',
          },
        }),
      ),
    );

    expect(inspector.finish(400).usageDetails).toEqual({
      input: 0,
      output: 0,
      total: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it('collects OpenAI-compatible streaming text and final usage', () => {
    const inspector = new DirectLlmResponseInspector('text/event-stream');
    inspector.inspect(
      Buffer.from(
        'data: {"id":"chat-1","choices":[{"delta":{"content":"hello "}}]}\n\n',
      ),
    );
    inspector.inspect(
      Buffer.from(
        'data: {"id":"chat-1","choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":30,"completion_tokens":4,"total_tokens":34,"prompt_tokens_details":{"cached_tokens":20}}}\n\n',
      ),
    );
    inspector.inspect(Buffer.from('data: [DONE]\n\n'));

    expect(inspector.finish(200)).toEqual({
      statusCode: 200,
      responseId: 'chat-1',
      outputPreview: 'hello world',
      usageDetails: {
        input: 10,
        output: 4,
        total: 34,
        cache_read_input_tokens: 20,
      },
    });
  });

  it('merges Anthropic streaming cache and output usage', () => {
    const inspector = new DirectLlmResponseInspector('text/event-stream');
    inspector.inspect(
      Buffer.from(
        'data: {"type":"message_start","message":{"id":"msg-stream-1","usage":{"input_tokens":100,"cache_read_input_tokens":80,"cache_creation_input_tokens":20}}}\n\n',
      ),
    );
    inspector.inspect(
      Buffer.from(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}\n\n',
      ),
    );
    inspector.inspect(
      Buffer.from(
        'data: {"type":"message_delta","usage":{"output_tokens":10}}\n\n',
      ),
    );

    expect(inspector.finish(200)).toEqual({
      statusCode: 200,
      responseId: 'msg-stream-1',
      outputPreview: 'done',
      usageDetails: {
        input: 100,
        output: 10,
        total: 210,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    });
  });

  it('accepts Gemini implicit-cache token accounting when reported', () => {
    const inspector = new DirectLlmResponseInspector('application/json');
    inspector.inspect(
      Buffer.from(
        JSON.stringify({
          id: 'gemini-1',
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 20,
            total_tokens: 3020,
            total_cached_tokens: 2200,
          },
        }),
      ),
    );

    expect(inspector.finish(200)).toEqual({
      statusCode: 200,
      responseId: 'gemini-1',
      outputPreview: '{"ok":true}',
      usageDetails: {
        input: 800,
        output: 20,
        total: 3020,
        cache_read_input_tokens: 2200,
      },
    });
  });

  it('ignores malformed distributed parent context', () => {
    const value = Buffer.from(
      JSON.stringify({
        operationName: 'normalizeFromDetail',
        parentTraceId: 'not-a-trace-id',
        parentSpanId: 'not-a-span-id',
      }),
    ).toString('base64url');

    expect(
      readDirectLlmObservationContext({
        'x-gantry-observability-context': value,
      }),
    ).not.toHaveProperty('parentSpanContext');
  });

  it('normalizes inclusive cached and reasoning token details once', () => {
    const inspector = new DirectLlmResponseInspector('application/json');
    inspector.inspect(
      Buffer.from(
        JSON.stringify({
          id: 'reasoning-1',
          choices: [{ message: { content: 'done' } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            total_tokens: 140,
            prompt_tokens_details: { cached_tokens: 75 },
            completion_tokens_details: { reasoning_tokens: 30 },
          },
        }),
      ),
    );

    expect(inspector.finish(200).usageDetails).toEqual({
      input: 25,
      cache_read_input_tokens: 75,
      output: 10,
      reasoning_output: 30,
      total: 140,
    });
  });
});
