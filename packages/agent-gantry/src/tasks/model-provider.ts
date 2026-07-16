import type {
  AnthropicStructuredModelEffort,
  AnthropicStructuredModelConfig,
  AnthropicStructuredModelTaskPolicy,
  GantryAgentTaskAttachment,
  GantryStructuredModelUsage,
  GantryStructuredModelConfig,
  StructuredJsonModelProvider,
  StructuredJsonModelProviderResult,
} from '../shared/types.js';
import {
  asNonEmptyString,
  asRecord,
  fetchWithTimeout,
  parseJsonRecord,
} from '../shared/helpers.js';
import {
  extractAnthropicUsageDetails,
  observeGantryModelCall,
} from './model-observability.js';
import { buildCompatibleJsonSchema } from './json-schema-output-format.js';

type AnthropicObservedResult = {
  readonly payload: Record<string, unknown>;
  readonly output: Record<string, unknown> | string;
  readonly rawText: string;
  readonly stopReason: string | null;
};

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
  const retryBaseDelayMs = Math.max(0, config.retryBaseDelayMs ?? 1_000);
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    config.retryMaxDelayMs ?? 30_000,
  );
  const apiVersion = config.apiVersion ?? '2023-06-01';

  return {
    generateJson: async (input) => {
      const taskPolicy = resolveAnthropicTaskPolicy(input.taskType, config);
      const model = taskPolicy.model;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          const startedAt = Date.now();
          const promptCacheMetadata = resolvePromptCache(input);
          const body = buildAnthropicRequestBody({
            input,
            model,
            maxTokens: taskPolicy.maxTokens,
            temperature: taskPolicy.temperature,
            effort: taskPolicy.effort,
          });
          const outputConfig = asRecord(body.output_config);
          const structuredOutputMode = input.outputSchema
            ? asRecord(outputConfig?.format)
              ? 'native'
              : 'local_validation'
            : 'none';
          const observed =
            await observeGantryModelCall<AnthropicObservedResult>(
              {
                operationName: 'anthropic.generateJson',
                taskType: input.taskType,
                modelCallType: 'agent_step',
                provider: 'anthropic',
                model,
                attempt,
                input: {
                  taskType: input.taskType,
                  instructions: input.instructions,
                  input: input.input,
                  outputSchema: input.outputSchema ?? null,
                  attachments:
                    input.attachments?.map((attachment) => ({
                      label: attachment.label ?? null,
                      mimeType: attachment.mimeType,
                      purpose: attachment.purpose ?? null,
                      sourceStep: attachment.sourceStep ?? null,
                      hasBase64: Boolean(attachment.base64),
                      hasLocalPath: Boolean(attachment.localPath),
                    })) ?? [],
                },
                output: (result: AnthropicObservedResult) => result.output,
                usageDetails: (result: AnthropicObservedResult) =>
                  extractAnthropicUsageDetails(result.payload),
                modelParameters: {
                  max_tokens: taskPolicy.maxTokens,
                  max_retries: maxRetries,
                  timeout_ms: timeoutMs,
                  structured_output_mode: structuredOutputMode,
                  ...(typeof taskPolicy.temperature === 'number'
                    ? { temperature: taskPolicy.temperature }
                    : {}),
                  ...(taskPolicy.effort ? { effort: taskPolicy.effort } : {}),
                },
                metadata: {
                  correlation_id: input.correlationId ?? null,
                  prompt_cache_ttl: promptCacheMetadata?.ttl ?? null,
                  prompt_cache_prefix_hash:
                    promptCacheMetadata?.prefixHash ?? null,
                },
                observability: input.observability,
                resultMetadata: (result: AnthropicObservedResult) => ({
                  response_id:
                    typeof result.payload.id === 'string'
                      ? result.payload.id
                      : null,
                  stop_reason: result.stopReason,
                  duration_ms: Date.now() - startedAt,
                }),
              },
              async () => {
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
                    body: JSON.stringify(body),
                  },
                  timeoutMs,
                );
                const payload = (await response.json()) as Record<
                  string,
                  unknown
                >;
                if (!response.ok) {
                  throw buildAnthropicError(response.status, payload);
                }
                const rawText = readAnthropicTextPayload(payload);
                const stopReason = asNonEmptyString(payload.stop_reason);
                const output = parseJsonRecordOrText(rawText);
                return { payload, output, rawText, stopReason };
              },
            );
          const payload = observed.payload;
          const output = observed.output;
          return {
            output,
            modelUsage: readAnthropicModelUsage({
              payload,
              body,
              output,
              model,
              taskType: input.taskType,
              correlationId: input.correlationId ?? null,
              durationMs: Date.now() - startedAt,
              promptCacheMetadata,
            }),
            rawText: observed.rawText,
            stopReason: observed.stopReason,
          };
        } catch (error) {
          lastError = error;
          if (attempt === maxRetries || !isRetryableAnthropicError(error))
            break;
          await sleep(
            calculateRetryDelayMs({
              attempt,
              baseDelayMs: retryBaseDelayMs,
              maxDelayMs: retryMaxDelayMs,
            }),
          );
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

function isRetryableAnthropicError(error: unknown): boolean {
  const statusCode = readAnthropicErrorStatusCode(error);
  if (statusCode === null) return true;
  return (
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode === 529 ||
    (statusCode >= 500 && statusCode <= 599)
  );
}

function readAnthropicErrorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && Number.isFinite(statusCode)
    ? statusCode
    : null;
}

function calculateRetryDelayMs(input: {
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}): number {
  if (input.baseDelayMs <= 0 || input.maxDelayMs <= 0) return 0;
  const exponentialDelayMs = Math.min(
    input.maxDelayMs,
    input.baseDelayMs * 2 ** Math.max(0, input.attempt - 1),
  );
  return Math.floor(exponentialDelayMs * (0.5 + Math.random() * 0.5));
}

function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

interface ResolvedAnthropicTaskPolicy {
  readonly model: string;
  readonly maxTokens: number;
  readonly effort: AnthropicStructuredModelEffort;
  readonly temperature?: number;
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

function resolveAnthropicTaskPolicy(
  taskType: string,
  config: AnthropicStructuredModelConfig,
): ResolvedAnthropicTaskPolicy {
  const policy = config.taskPolicies?.[taskType];
  const model =
    asNonEmptyString(policy?.model) ?? selectAnthropicModel(taskType, config);
  return {
    model,
    maxTokens: Math.max(1, policy?.maxTokens ?? config.maxTokens ?? 4096),
    effort: normalizeAnthropicEffort(policy?.effort),
    temperature: policy?.temperature ?? config.temperature,
  };
}

function normalizeAnthropicEffort(
  value: AnthropicStructuredModelTaskPolicy['effort'],
): AnthropicStructuredModelEffort {
  return value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max'
    ? value
    : 'off';
}

function buildAnthropicRequestBody(input: {
  readonly input: Parameters<StructuredJsonModelProvider['generateJson']>[0];
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly effort: AnthropicStructuredModelEffort;
}): Record<string, unknown> {
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    ...(input.temperature === undefined
      ? {}
      : { temperature: input.temperature }),
    ...buildAnthropicOutputRequestFields(
      input.effort,
      input.input.outputSchema,
    ),
    system: buildAnthropicSystemPrompt(input.input),
    messages: [
      {
        role: 'user',
        content: buildAnthropicUserContent(input.input),
      },
    ],
  };
}

function buildAnthropicOutputRequestFields(
  effort: AnthropicStructuredModelEffort,
  outputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const format = buildAnthropicOutputFormat(outputSchema);
  if (effort === 'off' && !format) return {};
  return {
    ...(effort === 'off' ? {} : { thinking: { type: 'adaptive' } }),
    output_config: {
      ...(effort === 'off' ? {} : { effort }),
      ...(format ? { format } : {}),
    },
  };
}

function buildAnthropicOutputFormat(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const compatibleSchema = buildCompatibleJsonSchema(schema, {
    optionalParameters: 24,
    unionParameters: 16,
  });
  return compatibleSchema
    ? { type: 'json_schema', schema: compatibleSchema }
    : null;
}

function buildAnthropicSystemPrompt(
  input: Parameters<StructuredJsonModelProvider['generateJson']>[0],
): string {
  if (resolvePromptCache(input)) {
    return [
      'You are a structured JSON task runner.',
      '',
      'Return exactly one JSON object. Do not include markdown fences, prose, or commentary outside JSON.',
    ].join('\n');
  }
  return [
    input.instructions.trim(),
    '',
    'Return exactly one JSON object. Do not include markdown fences, prose, or commentary outside JSON.',
  ].join('\n');
}

type AnthropicUserContentBlock =
  | {
      readonly type: 'text';
      readonly text: string;
      readonly cache_control?: {
        readonly type: 'ephemeral';
        readonly ttl?: '5m' | '1h';
      };
    }
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
  const promptCache = resolvePromptCache(input);
  const dynamicPrompt = [
    promptCache ? `Task instructions:\n${input.instructions.trim()}` : '',
    promptCache ? '' : '',
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
    ...(promptCache
      ? [
          {
            type: 'text' as const,
            text: promptCache.prefix,
            cache_control: {
              type: 'ephemeral' as const,
              ttl: promptCache.ttl,
            },
          },
        ]
      : []),
    { type: 'text', text: dynamicPrompt },
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

function resolvePromptCache(
  input: Parameters<StructuredJsonModelProvider['generateJson']>[0],
): {
  readonly prefix: string;
  readonly ttl: '5m' | '1h';
  readonly prefixHash: string | null;
} | null {
  const prefix = input.cacheablePrefix?.trim();
  if (!prefix || input.promptCache?.enabled !== true) {
    return null;
  }
  return {
    prefix,
    ttl: input.promptCache.ttl === '5m' ? '5m' : '1h',
    prefixHash: input.promptCache.prefixHash ?? null,
  };
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

function readAnthropicTextPayload(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .flatMap((entry) => {
      const record = asRecord(entry);
      return record?.type === 'text'
        ? [typeof record.text === 'string' ? record.text : '']
        : [];
    })
    .join('\n');
  if (!text.trim()) {
    throw new Error('Anthropic response did not include text content.');
  }
  return text;
}

function parseJsonRecordOrText(text: string): Record<string, unknown> | string {
  try {
    return parseJsonRecord(text);
  } catch {
    return text;
  }
}

function readAnthropicModelUsage(input: {
  readonly payload: Record<string, unknown>;
  readonly body: Record<string, unknown>;
  readonly output: Record<string, unknown> | string;
  readonly model: string;
  readonly taskType: string;
  readonly correlationId: string | null;
  readonly durationMs: number;
  readonly promptCacheMetadata: {
    readonly ttl: '5m' | '1h';
    readonly prefixHash: string | null;
  } | null;
}): GantryStructuredModelUsage {
  const usage = asRecord(input.payload.usage);
  const inputTokens = readOptionalNumber(usage?.input_tokens);
  const outputTokens = readOptionalNumber(usage?.output_tokens);
  const cacheReadInputTokens = readOptionalNumber(
    usage?.cache_read_input_tokens,
  );
  const cacheCreationInputTokens = readOptionalNumber(
    usage?.cache_creation_input_tokens,
  );
  const cachedTokens = cacheReadInputTokens ?? cacheCreationInputTokens;
  const promptCacheMetadata = input.promptCacheMetadata;
  const promptCharCount = JSON.stringify(input.body).length;
  if (inputTokens !== null || outputTokens !== null) {
    return {
      provider: 'anthropic',
      model: input.model,
      taskType: input.taskType,
      correlationId: input.correlationId,
      promptCharCount,
      inputTokens,
      outputTokens,
      totalTokens: addOptionalNumbers(inputTokens, outputTokens),
      cachedTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      promptCacheTtl: promptCacheMetadata?.ttl ?? null,
      promptCachePrefixHash: promptCacheMetadata?.prefixHash ?? null,
      durationMs: input.durationMs,
      usageSource: 'provider',
    };
  }
  const outputCharCount = JSON.stringify(input.output).length;
  const estimatedInputTokens = estimateTokensFromChars(promptCharCount);
  const estimatedOutputTokens = estimateTokensFromChars(outputCharCount);
  return {
    provider: 'anthropic',
    model: input.model,
    taskType: input.taskType,
    correlationId: input.correlationId,
    promptCharCount,
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
    totalTokens: estimatedInputTokens + estimatedOutputTokens,
    cachedTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    promptCacheTtl: promptCacheMetadata?.ttl ?? null,
    promptCachePrefixHash: promptCacheMetadata?.prefixHash ?? null,
    durationMs: input.durationMs,
    usageSource: 'estimated',
  };
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function addOptionalNumbers(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function estimateTokensFromChars(charCount: number): number {
  return Math.max(1, Math.ceil(charCount / 4));
}

export function unwrapStructuredJsonModelProviderResult(
  result: StructuredJsonModelProviderResult,
): {
  readonly output: Record<string, unknown> | string;
  readonly modelUsage: GantryStructuredModelUsage | null;
  readonly rawText: string | null;
  readonly stopReason: string | null;
} {
  if (isStructuredModelProviderEnvelope(result)) {
    return {
      output: result.output,
      modelUsage: result.modelUsage ?? null,
      rawText: result.rawText ?? null,
      stopReason: result.stopReason ?? null,
    };
  }
  return {
    output: result,
    modelUsage: null,
    rawText: typeof result === 'string' ? result : null,
    stopReason: null,
  };
}

export function readStructuredModelStopError(
  stopReason: string | null,
): 'model_output_truncated' | 'model_output_refused' | null {
  if (stopReason === 'max_tokens') return 'model_output_truncated';
  if (stopReason === 'refusal') return 'model_output_refused';
  return null;
}

function isStructuredModelProviderEnvelope(
  value: StructuredJsonModelProviderResult,
): value is {
  readonly output: Record<string, unknown> | string;
  readonly modelUsage?: GantryStructuredModelUsage | null;
  readonly rawText?: string | null;
  readonly stopReason?: string | null;
} {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'output' in value &&
    ('modelUsage' in value || 'rawText' in value || 'stopReason' in value),
  );
}
