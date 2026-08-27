import { tool } from '@langchain/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const handleFileToolAction = vi.hoisted(() => vi.fn());
vi.mock('@core/runner/mcp/tools/file.js', () => ({ handleFileToolAction }));

import { envelopeToolsForProvider } from '../../../src/adapters/llm/deepagents-langchain/runner/tool-input-envelope.js';

describe('DeepAgents tool-input envelope', () => {
  it('uses a portable JSON string at the provider boundary and invokes the original tool', async () => {
    const invoked = vi.fn(
      async (input: { payload: Record<string, unknown> }) => input,
    );
    const original = tool(invoked, {
      name: 'browser_act',
      description: 'Perform a browser action.',
      schema: z.object({ payload: z.record(z.string(), z.unknown()) }),
    });

    const [wrapped] = envelopeToolsForProvider([original], 'gemini');
    expect(wrapped).not.toBe(original);
    expect(wrapped?.description).toContain('"payload"');
    await wrapped?.invoke({ json: '{"payload":{"selector":"#open"}}' });
    expect(invoked).toHaveBeenCalledWith(
      { payload: { selector: '#open' } },
      expect.anything(),
    );
  });

  it('closes OpenAI Responses object schemas without JSON-string enveloping', async () => {
    const invoked = vi.fn(async (input: { value: string }) => input.value);
    const original = tool(async () => 'ok', {
      name: 'simple',
      description: 'Simple.',
      schema: z.object({
        value: z.string(),
        nested: z.object({ label: z.string() }).optional(),
      }),
    });
    const [resolved] = envelopeToolsForProvider([original], 'openai');
    const schema = resolved?.schema as Record<string, unknown>;
    expect(resolved).not.toBe(original);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['value', 'nested']);
    const nested = (
      schema.properties as Record<string, Record<string, unknown>>
    ).nested;
    expect(nested?.type).toEqual(['object', 'null']);
    expect(nested?.additionalProperties).toBe(false);
    const callable = tool(invoked, {
      name: 'callable',
      description: 'Callable.',
      schema: z.object({ value: z.string() }),
    });
    const [closedCallable] = envelopeToolsForProvider([callable], 'openai');
    await expect(closedCallable?.invoke({ value: 'ok' })).resolves.toBe('ok');
  });

  it('gives nullable OpenAI properties an explicit type', () => {
    const original = tool(async () => 'ok', {
      name: 'nullable',
      description: 'Nullable.',
      schema: z.object({ checkpointRef: z.string().nullable() }),
    });
    const [resolved] = envelopeToolsForProvider([original], 'openai');
    const schema = resolved?.schema as Record<string, unknown>;
    const checkpointRef = (
      schema.properties as Record<string, Record<string, unknown>>
    ).checkpointRef;
    expect(checkpointRef?.type).toEqual(['string', 'null']);
    expect(checkpointRef?.anyOf).toBeUndefined();
  });

  it('removes JSON Schema formats rejected by OpenAI tools', () => {
    const original = tool(async () => 'ok', {
      name: 'WebRead',
      description: 'Read URL.',
      schema: z.object({ url: z.url() }),
    });
    const [resolved] = envelopeToolsForProvider([original], 'openai');
    const url = (
      (resolved?.schema as Record<string, unknown>).properties as Record<
        string,
        Record<string, unknown>
      >
    ).url;
    expect(url?.type).toBe('string');
    expect(url?.format).toBeUndefined();
  });

  it('returns OpenAI browser failures to the agent for self-correction', async () => {
    const original = tool(
      async () => {
        throw new Error('page.goto: net::ERR_BLOCKED_BY_CLIENT');
      },
      {
        name: 'browser_open',
        description: 'Open.',
        schema: z.object({ url: z.string() }),
      },
    );
    const [resolved] = envelopeToolsForProvider([original], 'openai');
    await expect(
      resolved?.invoke({ url: 'https://example.com' }),
    ).resolves.toContain('Correct the arguments or approach and retry');
  });

  it('returns MCP argument validation failures to the agent for self-correction', async () => {
    const original = tool(
      async () => {
        throw new Error(
          'MCP error -32602: Input validation error: Invalid arguments for tool request_access: expected string at target.argvPattern',
        );
      },
      {
        name: 'request_access',
        description: 'Request access.',
        schema: z.object({ target: z.record(z.string(), z.unknown()) }),
      },
    );
    const [resolved] = envelopeToolsForProvider([original], 'openai');

    await expect(
      resolved?.invoke({ json: '{"target":{"kind":"run_command"}}' }),
    ).resolves.toContain('Correct the arguments or approach and retry');
  });

  it('removes OpenAI null placeholders when an optional tool field rejects them', async () => {
    const invoked = vi.fn(
      async (input: { action: string; version?: number }) => {
        if ('version' in input)
          throw new Error('Received tool input did not match expected schema');
        return input;
      },
    );
    const original = tool(invoked, {
      name: 'file',
      description: 'File.',
      schema: z.object({ action: z.string(), version: z.number().optional() }),
    });
    const [resolved] = envelopeToolsForProvider([original], 'openai');
    await expect(
      resolved?.invoke({ action: 'read', version: null }),
    ).resolves.toEqual({ action: 'read' });
    expect(invoked).toHaveBeenCalledTimes(1);
  });

  it('uses the portable envelope only for dynamic OpenAI object schemas', () => {
    const original = tool(async () => 'ok', {
      name: 'dynamic',
      description: 'Dynamic.',
      schema: z.object({ payload: z.record(z.string(), z.unknown()) }),
    });
    const [resolved] = envelopeToolsForProvider([original], 'openai');
    expect(resolved?.description).toContain('Pass arguments in the json field');
  });

  it('loads large dynamic inputs from a job-scoped JSON artifact', async () => {
    const invoked = vi.fn(
      async (input: { payload: Record<string, unknown> }) => input,
    );
    const original = tool(invoked, {
      name: 'mcp_call_tool',
      description: 'Call an approved MCP tool.',
      schema: z.object({ payload: z.record(z.string(), z.unknown()) }),
    });
    handleFileToolAction.mockResolvedValueOnce(
      '{"payload":{"recipe":"candidate"}}',
    );

    const [wrapped] = envelopeToolsForProvider([original], 'openai');
    await wrapped?.invoke({
      json: 'artifact:file-artifact:123e4567-e89b-12d3-a456-426614174000',
    });

    expect(handleFileToolAction).toHaveBeenCalledWith({
      action: 'read',
      artifactId: 'file-artifact:123e4567-e89b-12d3-a456-426614174000',
    });
    expect(invoked).toHaveBeenCalledWith(
      { payload: { recipe: 'candidate' } },
      expect.anything(),
    );
  });

  it('unwraps a matching legacy MCP call artifact when the adapter exposes the direct tool name', async () => {
    const invoked = vi.fn(async (input: Record<string, unknown>) => input);
    const original = tool(invoked, {
      name: 'recipe_compile',
      description: 'Compile a recipe.',
      schema: z.object({
        recipe: z.record(z.string(), z.unknown()),
        binding: z.record(z.string(), z.unknown()),
      }),
    });
    handleFileToolAction.mockResolvedValueOnce(
      JSON.stringify({
        serverName: 'manipal-website-recipe-evaluator',
        toolName: 'recipe_compile',
        arguments: {
          recipe: { contractVersion: 'manipal.website_recipe@2' },
          binding: { surfaceId: 'surface-1' },
        },
      }),
    );

    const [wrapped] = envelopeToolsForProvider([original], 'openai');
    await wrapped?.invoke({
      json: 'artifact:file-artifact:123e4567-e89b-12d3-a456-426614174000',
    });

    expect(invoked).toHaveBeenCalledWith(
      {
        recipe: { contractVersion: 'manipal.website_recipe@2' },
        binding: { surfaceId: 'surface-1' },
      },
      expect.anything(),
    );
  });

  it('envelopes OpenAI tools when schema conversion leaves an untyped property', () => {
    const original = tool(async () => 'ok', {
      name: 'caller_tool',
      description: 'Caller tool.',
      schema: z.object({ checkpointRef: z.unknown() }),
    });
    const [resolved] = envelopeToolsForProvider([original], 'openai');
    expect(resolved?.description).toContain('Pass arguments in the json field');
  });

  it('envelopes OpenAI tools containing unsupported schema combinators', () => {
    const original = tool(async () => 'ok', {
      name: 'FileSearch',
      description: 'Search files.',
      schema: {
        type: 'object',
        properties: {
          include: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      } as never,
    });
    const [resolved] = envelopeToolsForProvider([original], 'openai');
    expect(resolved?.description).toContain('Pass arguments in the json field');
  });

  it('leaves providers without envelope requirements unchanged', () => {
    const original = tool(async () => 'ok', {
      name: 'simple',
      description: 'Simple.',
      schema: z.object({}),
    });
    expect(envelopeToolsForProvider([original], 'anthropic')).toEqual([
      original,
    ]);
  });

  it('returns browser validation failures to the model for correction', async () => {
    const original = tool(
      async () => {
        throw new Error('profile="full" and reason are required');
      },
      {
        name: 'browser_act',
        description: 'Perform a browser action.',
        schema: z.object({ action: z.string() }),
      },
    );
    const [wrapped] = envelopeToolsForProvider([original], 'gemini');

    await expect(
      wrapped?.invoke({ json: '{"action":"evaluate"}' }),
    ).resolves.toContain('Correct the arguments or approach and retry');
    await expect(wrapped?.invoke({ json: '{broken' })).resolves.toContain(
      'not valid JSON',
    );
  });

  it('returns malformed JSON for non-browser tools to the model for correction', async () => {
    const original = tool(async () => 'ok', {
      name: 'mcp_call_tool',
      description: 'Call an approved MCP tool.',
      schema: z.object({ serverName: z.string(), toolName: z.string() }),
    });
    const [wrapped] = envelopeToolsForProvider([original], 'gemini');

    await expect(wrapped?.invoke({ json: '{broken' })).resolves.toBe(
      'mcp_call_tool failed: arguments were not valid JSON. Correct the json field or pass artifact:file-artifact:<id> for a job-scoped JSON input artifact, then retry.',
    );
  });

  it('returns approved MCP domain errors to the model for self-correction', async () => {
    const original = tool(
      async () => {
        throw new Error('OBSERVED_CAPABILITY_NOT_COVERED:documents');
      },
      {
        name: 'mcp_call_tool',
        description: 'Call an approved MCP tool.',
        schema: z.object({ serverName: z.string(), toolName: z.string() }),
      },
    );
    const [wrapped] = envelopeToolsForProvider([original], 'gemini');

    await expect(
      wrapped?.invoke({
        json: '{"serverName":"recipe","toolName":"recipe_compile"}',
      }),
    ).resolves.toContain('Correct the arguments or approach and retry');
  });

  it('returns checkpoint-read failures to the model instead of crashing the graph', async () => {
    const original = tool(
      async () => {
        throw new Error('checkpoint lease changed');
      },
      {
        name: 'job_checkpoint_status',
        description: 'Read checkpoint.',
        schema: z.object({ value: z.string() }),
      },
    );
    const [wrapped] = envelopeToolsForProvider([original], 'gemini');

    await expect(
      wrapped?.invoke({ json: '{"value":"read"}' }),
    ).resolves.toContain('checkpoint lease changed');
  });

  it('returns zero-argument checkpoint-read failures without an envelope', async () => {
    const original = tool(
      async () => {
        throw new Error('checkpoint lease changed');
      },
      {
        name: 'job_checkpoint_status',
        description: 'Read checkpoint.',
        schema: z.object({}),
      },
    );
    const [wrapped] = envelopeToolsForProvider([original], 'gemini');

    await expect(wrapped?.invoke({})).resolves.toContain(
      'checkpoint lease changed',
    );
  });

  it('returns prefixed checkpoint-read timeouts to an OpenAI agent for retry', async () => {
    const original = tool(
      async () => {
        throw new Error('Scheduler get job failed. timed out.');
      },
      {
        name: 'mcp__gantry__job_checkpoint_status',
        description: 'Read checkpoint.',
        schema: z.object({}),
      },
    );
    const [wrapped] = envelopeToolsForProvider([original], 'openai');

    await expect(wrapped?.invoke({})).resolves.toContain(
      'Inspect the error. Correct the arguments or approach and retry.',
    );
  });

  it('returns scheduler read timeouts to an OpenAI agent for retry', async () => {
    const original = tool(
      async () => {
        throw new Error('Scheduler get job failed. timed out.');
      },
      {
        name: 'scheduler_get_job',
        description: 'Read job.',
        schema: z.object({ job_id: z.string() }),
      },
    );
    const [wrapped] = envelopeToolsForProvider([original], 'openai');

    await expect(wrapped?.invoke({ job_id: 'job-1' })).resolves.toContain(
      'Inspect the error. Correct the arguments or approach and retry.',
    );
  });
});
