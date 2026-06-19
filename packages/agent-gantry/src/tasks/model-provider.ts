import type {
  AnthropicStructuredModelConfig,
  GantryAgentTaskAttachment,
  GantryStructuredModelConfig,
  StructuredJsonModelProvider,
} from '../shared/types.js';
import {
  asNonEmptyString,
  asRecord,
  fetchWithTimeout,
  parseJsonRecord,
} from '../shared/helpers.js';

export function resolveStructuredModelProvider(
  config: GantryStructuredModelConfig,
): StructuredJsonModelProvider {
  if (isStructuredJsonModelProvider(config)) {
    return config;
  }
  if (config.provider === 'anthropic') {
    return createAnthropicStructuredModelProvider(config);
  }
  throw new Error('Unsupported Gantry structured model provider.');
}

export function createAnthropicStructuredModelProvider(
  config: AnthropicStructuredModelConfig,
): StructuredJsonModelProvider {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required for Anthropic structured model tasks.',
    );
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1_000, config.timeoutMs ?? 60_000);
  const maxRetries = Math.max(1, config.maxRetries ?? 3);
  const maxTokens = Math.max(1, config.maxTokens ?? 4096);
  const temperature = config.temperature ?? 0;
  const apiVersion = config.apiVersion ?? '2023-06-01';

  return {
    generateJson: async (input) => {
      const model = selectAnthropicModel(input.taskType, config);
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          const response = await fetchWithTimeout(
            fetchImpl,
            'https://api.anthropic.com/v1/messages',
            {
              method: 'POST',
              headers: {
                'anthropic-version': apiVersion,
                'content-type': 'application/json',
                'x-api-key': apiKey,
              },
              body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                temperature,
                system: buildAnthropicSystemPrompt(input.instructions),
                messages: [
                  {
                    role: 'user',
                    content: buildAnthropicUserContent(input),
                  },
                ],
              }),
            },
            timeoutMs,
          );
          const payload = (await response.json()) as Record<string, unknown>;
          if (!response.ok) {
            throw buildAnthropicError(response.status, payload);
          }
          return parseAnthropicJsonPayload(payload);
        } catch (error) {
          lastError = error;
          if (attempt === maxRetries) break;
        }
      }
      throw new Error(
        `Anthropic ${input.taskType} failed after ${maxRetries} attempts: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    },
  };
}

function isStructuredJsonModelProvider(
  value: GantryStructuredModelConfig,
): value is StructuredJsonModelProvider {
  return (
    typeof (value as StructuredJsonModelProvider).generateJson === 'function'
  );
}

function selectAnthropicModel(
  taskType: string,
  config: AnthropicStructuredModelConfig,
): string {
  return (
    asNonEmptyString(config.taskModels?.[taskType]) ??
    asNonEmptyString(config.model) ??
    asNonEmptyString(config.defaultModel) ??
    'claude-sonnet-4-6'
  );
}

function buildAnthropicSystemPrompt(instructions: string): string {
  return [
    instructions.trim(),
    '',
    'Return exactly one JSON object. Do not include markdown fences, prose, or commentary outside JSON.',
  ].join('\n');
}

type AnthropicUserContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly source: {
        readonly type: 'base64';
        readonly media_type: string;
        readonly data: string;
      };
    };

function buildAnthropicUserContent(
  input: Parameters<StructuredJsonModelProvider['generateJson']>[0],
): AnthropicUserContentBlock[] {
  const prompt = [
    'Task type:',
    input.taskType,
    '',
    'Correlation id:',
    input.correlationId ?? '',
    '',
    'Input JSON:',
    JSON.stringify(input.input),
    '',
    'Output schema JSON:',
    JSON.stringify(input.outputSchema ?? {}),
    '',
    input.attachments?.length
      ? `Attachment metadata JSON:\n${JSON.stringify(
          input.attachments.map((attachment) => ({
            label: attachment.label ?? null,
            mimeType: attachment.mimeType,
            purpose: attachment.purpose ?? null,
            sourceStep: attachment.sourceStep ?? null,
            hasInlineData: Boolean(attachment.base64),
            hasLocalPath: Boolean(attachment.localPath),
          })),
        )}`
      : '',
  ]
    .filter((part) => part !== '')
    .join('\n');
  return [
    { type: 'text', text: prompt },
    ...readInlineImageAttachments(input.attachments).map((attachment) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: attachment.mimeType,
        data: attachment.base64,
      },
    })),
  ];
}

function readInlineImageAttachments(
  attachments: readonly GantryAgentTaskAttachment[] | undefined,
): Array<{ readonly mimeType: string; readonly base64: string }> {
  return (attachments ?? [])
    .filter((attachment) => attachment.mimeType.startsWith('image/'))
    .map((attachment) => ({
      mimeType: attachment.mimeType,
      base64: asNonEmptyString(attachment.base64) ?? '',
    }))
    .filter((attachment) => attachment.base64.length > 0);
}

function buildAnthropicError(
  status: number,
  payload: Record<string, unknown>,
): Error {
  const errorRecord = asRecord(payload.error);
  const message =
    asNonEmptyString(errorRecord?.message) ??
    asNonEmptyString(payload.message) ??
    `Anthropic request failed with HTTP ${status}.`;
  return Object.assign(
    new Error(`Anthropic request failed with HTTP ${status}: ${message}`),
    {
      statusCode: status,
    },
  );
}

function parseAnthropicJsonPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .flatMap((entry) => {
      const record = asRecord(entry);
      return record?.type === 'text'
        ? [asNonEmptyString(record.text) ?? '']
        : [];
    })
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('Anthropic response did not include text content.');
  }
  return parseJsonRecord(stripJsonFence(text));
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}
