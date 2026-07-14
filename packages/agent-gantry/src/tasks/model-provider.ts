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
  parseJsonRecord,
} from '../shared/helpers.js';
import {
  createGantryGenerationClient,
  isRetryableGantryGenerationError,
} from '../generation-client.js';

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
  const gantryBaseUrl = config.gantryBaseUrl?.trim();
  const gantryApiKey = config.gantryApiKey?.trim();
  if (!gantryBaseUrl || !gantryApiKey) {
    throw new Error(
      'gantryBaseUrl and gantryApiKey are required for Anthropic structured model tasks.',
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
  const client = createGantryGenerationClient({
    baseUrl: gantryBaseUrl,
    apiKey: gantryApiKey,
    fetchImpl,
    resolveOperation: (operationName) => ({
      provider: 'anthropic',
      model: resolveAnthropicTaskPolicy(operationName, config).model,
    }),
  });

  return {
    generateJson: async (input) => {
      const taskPolicy = resolveAnthropicTaskPolicy(input.taskType, config);
      const model = taskPolicy.model;
      let lastError: unknown = null;
      let attemptsMade = 0;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        attemptsMade = attempt;
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
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          const result = await client
            .invokeGeneration({
              operationName: input.taskType,
              system:
                promptCacheMetadata?.prefix ??
                buildAnthropicSystemPrompt(input),
              content: {
                text: buildGatewayUserText(input, Boolean(promptCacheMetadata)),
                images: input.attachments
                  ?.filter((attachment) =>
                    attachment.mimeType.startsWith('image/'),
                  )
                  .map((attachment) => ({
                    mimeType: attachment.mimeType,
                    ...(attachment.base64 ? { base64: attachment.base64 } : {}),
                    ...(attachment.localPath
                      ? { localPath: attachment.localPath }
                      : {}),
                  })),
              },
              responseFormat: input.outputSchema
                ? {
                    type: 'json_schema',
                    name: schemaName(input.taskType),
                    schema: input.outputSchema,
                    strict: true,
                  }
                : undefined,
              promptCache: promptCacheMetadata
                ? { ttl: promptCacheMetadata.ttl }
                : undefined,
              maxOutputTokens: taskPolicy.maxTokens,
              temperature: taskPolicy.temperature,
              thinking: { effort: taskPolicy.effort },
              observability: {
                ...input.observability,
                serviceName: 'agent-gantry',
                attempt,
                modelCallType: 'agent_step',
                metadata: {
                  ...(input.observability?.metadata ?? {}),
                  task_type: input.taskType,
                  correlation_id: input.correlationId ?? null,
                  prompt_cache_ttl: promptCacheMetadata?.ttl ?? null,
                  prompt_cache_prefix_hash:
                    promptCacheMetadata?.prefixHash ?? null,
                },
              },
              signal: controller.signal,
            })
            .finally(() => clearTimeout(timeout));
          const payload = result.rawResponse as Record<string, unknown>;
          const output = parseJsonRecord(result.text);
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
        `Anthropic ${input.taskType} failed after ${attemptsMade} attempts: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    },
  };
}

function isRetryableAnthropicError(error: unknown): boolean {
  if (isRetryableGantryGenerationError(error)) return true;
  return (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      /structured task model output|valid json/i.test(error.message))
  );
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
    ...buildAnthropicEffortRequestFields(input.effort),
    system: buildAnthropicSystemPrompt(input.input),
    messages: [
      {
        role: 'user',
        content: buildAnthropicUserContent(input.input),
      },
    ],
  };
}

function buildAnthropicEffortRequestFields(
  effort: AnthropicStructuredModelEffort,
): Record<string, unknown> {
  if (effort === 'off') return {};
  return {
    thinking: { type: 'adaptive' },
    output_config: { effort },
  };
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

function buildGatewayUserText(
  input: Parameters<StructuredJsonModelProvider['generateJson']>[0],
  hasCacheablePrefix: boolean,
): string {
  return buildAnthropicUserContent(input)
    .filter(
      (block): block is Extract<AnthropicUserContentBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    .filter((_block, index) => !hasCacheablePrefix || index > 0)
    .map((block) => block.text)
    .join('\n');
}

function schemaName(taskType: string): string {
  return (
    taskType.replace(/[^a-zA-Z0-9_-]+/gu, '_').slice(0, 64) ||
    'structured_output'
  );
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

function readAnthropicModelUsage(input: {
  readonly payload: Record<string, unknown>;
  readonly body: Record<string, unknown>;
  readonly output: Record<string, unknown>;
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
  const cachedTokens = cacheReadInputTokens;
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
      totalTokens: addOptionalNumbers(
        inputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        outputTokens,
      ),
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
  ...values: readonly (number | null)[]
): number | null {
  const defined = values.filter((value): value is number => value !== null);
  return defined.length > 0
    ? defined.reduce((total, value) => total + value, 0)
    : null;
}

function estimateTokensFromChars(charCount: number): number {
  return Math.max(1, Math.ceil(charCount / 4));
}

export function unwrapStructuredJsonModelProviderResult(
  result: StructuredJsonModelProviderResult,
): {
  readonly output: Record<string, unknown> | string;
  readonly modelUsage: GantryStructuredModelUsage | null;
} {
  if (isStructuredModelProviderEnvelope(result)) {
    return {
      output: result.output,
      modelUsage: result.modelUsage ?? null,
    };
  }
  return { output: result, modelUsage: null };
}

function isStructuredModelProviderEnvelope(
  value: StructuredJsonModelProviderResult,
): value is {
  readonly output: Record<string, unknown> | string;
  readonly modelUsage?: GantryStructuredModelUsage | null;
} {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'output' in value &&
    'modelUsage' in value,
  );
}
