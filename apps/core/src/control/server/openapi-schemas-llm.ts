import type { JsonSchema } from './openapi-route-helpers.js';

const ref = (name: string): JsonSchema => ({
  $ref: `#/components/schemas/${name}`,
});

const cacheControl = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['ephemeral'] },
    ttl: { type: 'string', enum: ['5m', '1h'] },
  },
} as const;

const messagesContent = {
  oneOf: [
    { type: 'string' },
    {
      type: 'array',
      items: ref('LlmMessagesContentBlockInput'),
    },
  ],
} as const;

const messagesSystem = {
  oneOf: [
    { type: 'string' },
    {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'text'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['text'] },
          text: { type: 'string' },
          cache_control: cacheControl,
        },
      },
    },
  ],
} as const;

const messagesRequestProperties = {
  model: {
    type: 'string',
    description: 'Registered Gantry model alias.',
  },
  messages: {
    type: 'array',
    maxItems: 100000,
    items: ref('LlmMessagesInputMessage'),
  },
  system: messagesSystem,
  tools: {
    type: 'array',
    items: ref('LlmMessagesTool'),
  },
  tool_choice: ref('LlmMessagesToolChoice'),
  thinking: ref('LlmMessagesThinking'),
  cache_control: {
    oneOf: [cacheControl, { type: 'null' }],
  },
  output_config: ref('LlmMessagesOutputConfig'),
  betas: { type: 'array', items: { type: 'string' } },
} as const;

export const llmOpenApiSchemas: Record<string, JsonSchema> = {
  LlmJsonValue: {},
  LlmJsonObject: {},
  LlmMessagesContentBlockInput: {
    oneOf: [
      {
        type: 'object',
        required: ['type', 'text'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['text'] },
          text: { type: 'string' },
          cache_control: cacheControl,
        },
      },
      {
        type: 'object',
        required: ['type'],
        description:
          'Provider-native non-text content block such as image, document, tool use, or tool result.',
        properties: { type: { type: 'string' } },
        additionalProperties: true,
      },
    ],
  },
  LlmMessagesInputMessage: {
    type: 'object',
    required: ['role', 'content'],
    additionalProperties: false,
    properties: {
      role: { type: 'string', enum: ['user', 'assistant'] },
      content: messagesContent,
    },
  },
  LlmMessagesTool: {
    type: 'object',
    required: ['name', 'input_schema'],
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      input_schema: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: ['object'] },
          properties: { type: ['object', 'null'] },
          required: {
            type: ['array', 'null'],
            items: { type: 'string' },
          },
        },
        additionalProperties: true,
      },
      cache_control: cacheControl,
      strict: { type: 'boolean' },
      defer_loading: { type: 'boolean' },
    },
  },
  LlmMessagesToolChoice: {
    type: 'object',
    required: ['type'],
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['auto', 'any', 'tool', 'none'] },
      name: { type: 'string' },
      disable_parallel_tool_use: { type: 'boolean' },
    },
  },
  LlmMessagesThinking: {
    type: 'object',
    required: ['type'],
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['enabled', 'disabled', 'adaptive'] },
      budget_tokens: { type: 'integer', minimum: 1024 },
      display: {
        type: ['string', 'null'],
        enum: ['summarized', 'omitted', null],
      },
    },
  },
  LlmMessagesOutputConfig: {
    type: 'object',
    additionalProperties: false,
    properties: {
      effort: {
        type: ['string', 'null'],
        enum: ['low', 'medium', 'high', 'xhigh', 'max', null],
      },
      format: {
        oneOf: [ref('LlmJsonObject'), { type: 'null' }],
        description: 'Provider JSON output-format schema.',
      },
    },
  },
  LlmMessagesRequest: {
    type: 'object',
    required: ['model', 'messages', 'max_tokens'],
    additionalProperties: false,
    properties: {
      ...messagesRequestProperties,
      max_tokens: { type: 'integer', minimum: 1 },
      stream: { type: 'boolean' },
      stop_sequences: { type: 'array', items: { type: 'string' } },
      temperature: { type: 'number', minimum: 0, maximum: 1 },
      top_p: { type: 'number', minimum: 0, maximum: 1 },
      top_k: { type: 'integer', minimum: 0 },
      metadata: {
        type: 'object',
        additionalProperties: false,
        properties: { user_id: { type: 'string' } },
      },
      service_tier: { type: 'string', enum: ['auto', 'standard_only'] },
    },
  },
  LlmMessagesCountTokensRequest: {
    type: 'object',
    required: ['model', 'messages'],
    additionalProperties: false,
    properties: messagesRequestProperties,
  },
  LlmMessagesResponseContentBlock: {
    oneOf: [
      {
        type: 'object',
        required: ['type', 'text'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['text'] },
          text: { type: 'string' },
          citations: { type: 'array', items: ref('LlmJsonObject') },
        },
      },
      {
        type: 'object',
        required: ['type', 'thinking', 'signature'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['thinking'] },
          thinking: { type: 'string' },
          signature: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['type', 'data'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['redacted_thinking'] },
          data: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['type', 'id', 'name', 'input'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['tool_use'] },
          id: { type: 'string' },
          name: { type: 'string' },
          input: ref('LlmJsonObject'),
        },
      },
    ],
  },
  LlmMessagesUsage: {
    type: 'object',
    required: ['input_tokens', 'output_tokens'],
    additionalProperties: false,
    properties: {
      input_tokens: { type: 'integer', minimum: 0 },
      output_tokens: { type: 'integer', minimum: 0 },
      cache_creation_input_tokens: { type: 'integer', minimum: 0 },
      cache_read_input_tokens: { type: 'integer', minimum: 0 },
      service_tier: { type: 'string' },
    },
  },
  LlmMessagesResponse: {
    type: 'object',
    required: [
      'id',
      'type',
      'role',
      'content',
      'model',
      'stop_reason',
      'stop_sequence',
      'usage',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      type: { type: 'string', enum: ['message'] },
      role: { type: 'string', enum: ['assistant'] },
      content: {
        type: 'array',
        items: ref('LlmMessagesResponseContentBlock'),
      },
      model: { type: 'string' },
      stop_reason: { type: ['string', 'null'] },
      stop_sequence: { type: ['string', 'null'] },
      usage: ref('LlmMessagesUsage'),
    },
  },
  LlmMessagesCountTokensResponse: {
    type: 'object',
    required: ['input_tokens'],
    additionalProperties: false,
    properties: {
      input_tokens: { type: 'integer', minimum: 0 },
    },
  },
  LlmChatContentPart: {
    oneOf: [
      {
        type: 'object',
        required: ['type', 'text'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['text'] },
          text: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['type', 'image_url'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['image_url'] },
          image_url: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                required: ['url'],
                additionalProperties: false,
                properties: {
                  url: { type: 'string' },
                  detail: { type: 'string', enum: ['auto', 'low', 'high'] },
                },
              },
            ],
          },
        },
      },
      {
        type: 'object',
        required: ['type', 'refusal'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['refusal'] },
          refusal: { type: 'string' },
        },
      },
    ],
  },
  LlmChatToolCall: {
    type: 'object',
    required: ['id', 'type', 'function'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      type: { type: 'string', enum: ['function'] },
      function: {
        type: 'object',
        required: ['name', 'arguments'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          arguments: { type: 'string' },
        },
      },
    },
  },
  LlmChatInputMessage: {
    type: 'object',
    required: ['role'],
    additionalProperties: false,
    properties: {
      role: {
        type: 'string',
        enum: ['developer', 'system', 'user', 'assistant', 'tool'],
      },
      content: {
        oneOf: [
          { type: 'string' },
          { type: 'null' },
          { type: 'array', items: ref('LlmChatContentPart') },
        ],
      },
      name: { type: 'string' },
      tool_call_id: { type: 'string' },
      refusal: { type: ['string', 'null'] },
      tool_calls: { type: 'array', items: ref('LlmChatToolCall') },
    },
  },
  LlmChatFunctionTool: {
    type: 'object',
    required: ['type', 'function'],
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['function'] },
      function: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          parameters: ref('LlmJsonObject'),
          strict: { type: 'boolean' },
        },
      },
    },
  },
  LlmChatResponseFormat: {
    oneOf: [
      {
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: { type: { type: 'string', enum: ['text'] } },
      },
      {
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: { type: { type: 'string', enum: ['json_object'] } },
      },
      {
        type: 'object',
        required: ['type', 'json_schema'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['json_schema'] },
          json_schema: {
            type: 'object',
            required: ['name', 'schema'],
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              schema: ref('LlmJsonObject'),
              strict: { type: 'boolean' },
            },
          },
        },
      },
    ],
  },
  LlmChatCompletionsRequest: {
    type: 'object',
    required: ['model', 'messages'],
    additionalProperties: false,
    properties: {
      model: {
        type: 'string',
        description: 'Registered Gantry model alias.',
      },
      messages: { type: 'array', items: ref('LlmChatInputMessage') },
      max_tokens: { type: 'integer', minimum: 1 },
      max_completion_tokens: { type: 'integer', minimum: 1 },
      stream: { type: 'boolean' },
      stream_options: {
        type: 'object',
        additionalProperties: false,
        properties: { include_usage: { type: 'boolean' } },
      },
      temperature: { type: 'number', minimum: 0, maximum: 2 },
      top_p: { type: 'number', minimum: 0, maximum: 1 },
      n: { type: 'integer', minimum: 1 },
      stop: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
          { type: 'null' },
        ],
      },
      presence_penalty: { type: 'number', minimum: -2, maximum: 2 },
      frequency_penalty: { type: 'number', minimum: -2, maximum: 2 },
      logit_bias: { type: 'object', additionalProperties: { type: 'number' } },
      logprobs: { type: 'boolean' },
      top_logprobs: { type: 'integer', minimum: 0, maximum: 20 },
      user: { type: 'string' },
      seed: { type: 'integer' },
      tools: { type: 'array', items: ref('LlmChatFunctionTool') },
      tool_choice: {
        oneOf: [
          { type: 'string', enum: ['none', 'auto', 'required'] },
          {
            type: 'object',
            required: ['type', 'function'],
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['function'] },
              function: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: { name: { type: 'string' } },
              },
            },
          },
        ],
      },
      parallel_tool_calls: { type: 'boolean' },
      response_format: ref('LlmChatResponseFormat'),
      reasoning_effort: {
        type: 'string',
        enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      },
      service_tier: { type: 'string' },
      store: { type: 'boolean' },
      metadata: { type: 'object', additionalProperties: { type: 'string' } },
      extra_body: {
        type: 'object',
        description:
          'Provider-compatible extension object, including Google thinking_config.',
        additionalProperties: true,
      },
    },
  },
  LlmChatResponseMessage: {
    type: 'object',
    required: ['role', 'content'],
    additionalProperties: false,
    properties: {
      role: { type: 'string', enum: ['assistant'] },
      content: { type: ['string', 'null'] },
      refusal: { type: ['string', 'null'] },
      tool_calls: { type: 'array', items: ref('LlmChatToolCall') },
    },
  },
  LlmChatUsage: {
    type: 'object',
    required: ['prompt_tokens', 'completion_tokens', 'total_tokens'],
    additionalProperties: false,
    properties: {
      prompt_tokens: { type: 'integer', minimum: 0 },
      completion_tokens: { type: 'integer', minimum: 0 },
      total_tokens: { type: 'integer', minimum: 0 },
      prompt_tokens_details: ref('LlmJsonObject'),
      completion_tokens_details: ref('LlmJsonObject'),
    },
  },
  LlmChatCompletionsResponse: {
    type: 'object',
    required: ['id', 'object', 'created', 'model', 'choices'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      object: { type: 'string', enum: ['chat.completion'] },
      created: { type: 'integer' },
      model: { type: 'string' },
      choices: {
        type: 'array',
        items: {
          type: 'object',
          required: ['index', 'message', 'finish_reason'],
          additionalProperties: false,
          properties: {
            index: { type: 'integer', minimum: 0 },
            message: ref('LlmChatResponseMessage'),
            finish_reason: { type: ['string', 'null'] },
            logprobs: {
              oneOf: [ref('LlmJsonObject'), { type: 'null' }],
            },
          },
        },
      },
      usage: {
        oneOf: [ref('LlmChatUsage'), { type: 'null' }],
      },
      service_tier: { type: ['string', 'null'] },
      system_fingerprint: { type: ['string', 'null'] },
    },
  },
};
