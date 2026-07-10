import { describe, expect, it } from 'vitest';

import { findUnsupportedLlmRequestField } from '@core/control/server/routes/llm-request-validator.js';

describe('LLM passthrough request validator', () => {
  it('allows client-side tools, structured output, and thinking parameters', () => {
    expect(
      findUnsupportedLlmRequestField('messages', {
        tools: [
          {
            name: 'lookup_weather',
            input_schema: {
              type: 'object',
              properties: { city: { type: 'string' } },
            },
          },
        ],
        betas: ['prompt-caching-2024-07-31'],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }),
    ).toBeNull();
    expect(
      findUnsupportedLlmRequestField('chat_completions', {
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
              parameters: {
                type: 'object',
                properties: { file_id: { type: 'string' } },
              },
            },
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', schema: { type: 'object' } },
        },
        reasoning_effort: 'medium',
      }),
    ).toBeNull();
  });

  it.each([
    'web_search_20250305',
    'web_fetch_20250910',
    'code_execution_20250522',
    'computer_20250124',
    'bash_20250124',
    'text_editor_20250124',
    'tool_search_tool_regex_20251119',
  ])('rejects Anthropic server tool type %s', (toolType) => {
    expect(
      findUnsupportedLlmRequestField('messages', {
        tools: [{ type: toolType, name: 'server_tool' }],
      }),
    ).toMatchObject({ field: 'tools[0].type', toolType });
  });

  it.each(['mcp_servers', 'container'])(
    'rejects Anthropic provider-side field %s',
    (field) => {
      expect(
        findUnsupportedLlmRequestField('messages', { [field]: {} }),
      ).toMatchObject({ field });
    },
  );

  it('rejects execution betas while allowing harmless betas', () => {
    expect(
      findUnsupportedLlmRequestField('messages', {
        betas: ['prompt-caching-2024-07-31', 'computer-use-2025-01-24'],
      }),
    ).toMatchObject({
      field: 'betas[1]',
      value: 'computer-use-2025-01-24',
    });
  });

  it.each(['web_search_preview', 'file_search', 'code_interpreter'])(
    'rejects OpenAI hosted tool type %s',
    (toolType) => {
      expect(
        findUnsupportedLlmRequestField('chat_completions', {
          tools: [{ type: toolType }],
        }),
      ).toMatchObject({ field: 'tools[0].type', toolType });
    },
  );

  it.each([
    'web_search_options',
    'file_search',
    'code_interpreter',
    'code_interpreter_options',
    'tool_resources',
  ])('rejects OpenAI hosted-tool field %s', (field) => {
    expect(
      findUnsupportedLlmRequestField('chat_completions', { [field]: {} }),
    ).toMatchObject({ field });
  });

  it.each([
    [{ attachments: [{ file_id: 'file_1' }] }, 'attachments'],
    [
      { messages: [{ role: 'user', attachments: [] }] },
      'messages[0].attachments',
    ],
    [
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'file', file: { file_id: 'file_1' } }],
          },
        ],
      },
      'messages[0].content[0].type',
    ],
  ] as const)('rejects OpenAI file references at %s', (body, field) => {
    expect(
      findUnsupportedLlmRequestField('chat_completions', body),
    ).toMatchObject({ field });
  });
});
