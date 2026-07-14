import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { getActiveSpanId, getActiveTraceId } from '@langfuse/tracing';

const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const OBSERVABILITY_HEADER = 'x-gantry-observability-context';
const MAX_OBSERVABILITY_HEADER_BYTES = 16 * 1024;

export type GantryGenerationProvider = 'anthropic' | 'gemini';

export interface GantryGenerationRoute {
  readonly provider: GantryGenerationProvider;
  /** Existing application model value. The client converts it to a Gantry alias. */
  readonly model: string;
}

export interface GantryGenerationImage {
  readonly mimeType?: string;
  readonly base64?: string;
  readonly localPath?: string;
}

export interface GantryGenerationObservability {
  readonly flowId?: string | null;
  readonly flowType?: string | null;
  readonly flowStage?: string | null;
  readonly sessionId?: string | null;
  readonly userId?: string | null;
  readonly traceName?: string | null;
  readonly serviceName?: string | null;
  readonly attempt?: number | null;
  readonly costCategory?: string | null;
  readonly costStage?: string | null;
  readonly modelCallType?: 'generation' | 'rerank' | 'ocr' | 'agent_step';
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GantryGenerationInput {
  readonly operationName: string;
  readonly system: string;
  readonly content: {
    readonly text: string;
    readonly images?: readonly GantryGenerationImage[];
  };
  readonly promptCache?: {
    readonly ttl?: '5m' | '1h';
  } | null;
  readonly responseFormat?:
    | { readonly type: 'text' }
    | {
        readonly type: 'json_schema';
        readonly name: string;
        readonly schema: Readonly<Record<string, unknown>>;
        readonly strict?: boolean;
      };
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly thinking?: {
    readonly effort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max';
    readonly budgetTokens?: number | null;
  };
  readonly observability?: GantryGenerationObservability | null;
  readonly signal?: AbortSignal;
}

export interface GantryGenerationUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
}

export interface GantryGenerationResult {
  readonly text: string;
  readonly responseId: string | null;
  readonly usage: GantryGenerationUsage;
  readonly rawResponse: Readonly<Record<string, unknown>>;
}

export interface GantryGenerationClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly resolveOperation: (operationName: string) => GantryGenerationRoute;
  readonly fetchImpl?: typeof fetch;
}

export class GantryGenerationError extends Error {
  readonly statusCode: number | null;
  readonly code: string | null;
  readonly retryAfterMs: number | null;
  readonly providerRequestId: string | null;

  constructor(input: {
    readonly message: string;
    readonly statusCode?: number | null;
    readonly code?: string | null;
    readonly retryAfterMs?: number | null;
    readonly providerRequestId?: string | null;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'GantryGenerationError';
    this.statusCode = input.statusCode ?? null;
    this.code = input.code ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.providerRequestId = input.providerRequestId ?? null;
  }
}

export class GantryGenerationClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GantryGenerationClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
    if (!this.baseUrl) throw new Error('Gantry LLM baseUrl is required.');
    if (!config.apiKey.trim())
      throw new Error('Gantry LLM apiKey is required.');
  }

  async invokeGeneration(
    input: GantryGenerationInput,
  ): Promise<GantryGenerationResult> {
    const operationName = input.operationName.trim();
    if (!operationName) throw new Error('operationName is required.');
    if (!input.system.trim()) throw new Error('system is required.');
    if (!input.content.text.trim() && !input.content.images?.length) {
      throw new Error('content text or images are required.');
    }

    const route = this.config.resolveOperation(operationName);
    const model = toGantryModelAlias(route.model);
    const images = await resolveImages(input.content.images ?? []);
    const request =
      route.provider === 'anthropic'
        ? buildAnthropicRequest(input, images, model)
        : buildGeminiRequest(input, images, model);
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
      throw new GantryGenerationError({
        message: `Gantry LLM request exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`,
        code: 'REQUEST_TOO_LARGE',
      });
    }

    const path =
      route.provider === 'anthropic'
        ? '/llm/v1/messages'
        : '/llm/v1/chat/completions';
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (route.provider === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
    }
    const observabilityHeader = buildObservabilityHeader(
      input,
      route.provider,
      route.model,
      images,
    );
    if (observabilityHeader)
      headers[OBSERVABILITY_HEADER] = observabilityHeader;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body,
        signal: input.signal,
      });
    } catch (error) {
      throw new GantryGenerationError({
        message:
          error instanceof Error ? error.message : 'Gantry LLM request failed.',
        code: 'NETWORK_ERROR',
        cause: error,
      });
    }

    const responseText = await response.text();
    const payload = parseRecord(responseText);
    if (!response.ok) {
      throw generationHttpError(response, payload, responseText);
    }
    return route.provider === 'anthropic'
      ? parseAnthropicResult(payload)
      : parseGeminiResult(payload);
  }
}

export function createGantryGenerationClient(
  config: GantryGenerationClientConfig,
): GantryGenerationClient {
  return new GantryGenerationClient(config);
}

export function isRetryableGantryGenerationError(error: unknown): boolean {
  if (!(error instanceof GantryGenerationError)) return false;
  if (error.code === 'NETWORK_ERROR') return true;
  return (
    error.statusCode === 408 ||
    error.statusCode === 429 ||
    error.statusCode === 529 ||
    (error.statusCode !== null &&
      error.statusCode >= 500 &&
      error.statusCode <= 504)
  );
}

export function toGantryModelAlias(model: string): string {
  const value = model.trim();
  const aliases: Readonly<Record<string, string>> = {
    'claude-sonnet-4-6': 'sonnet-4.6',
    'claude-haiku': 'haiku-4.5',
    'claude-haiku-4-5': 'haiku-4.5',
    'claude-haiku-4-5-20251001': 'haiku-4.5',
    'gemini-3-flash-preview': 'gemini-preview-3-flash',
    'gemini-3.1-pro-preview': 'gemini-preview-3.1-pro',
  };
  return aliases[value] ?? value;
}

type ResolvedImage = {
  readonly mimeType: string;
  readonly base64: string;
  readonly bytes: number;
  readonly sha256: string;
};

async function resolveImages(
  images: readonly GantryGenerationImage[],
): Promise<ResolvedImage[]> {
  return await Promise.all(
    images.map(async (image) => {
      const hasBase64 = Boolean(image.base64?.trim());
      const hasLocalPath = Boolean(image.localPath?.trim());
      if (hasBase64 === hasLocalPath) {
        throw new Error(
          'Each generation image must provide exactly one of base64 or localPath.',
        );
      }
      const data = hasLocalPath
        ? await readFile(image.localPath!.trim())
        : Buffer.from(image.base64!.trim(), 'base64');
      if (data.byteLength === 0) throw new Error('Generation image is empty.');
      const mimeType =
        image.mimeType?.trim() || mimeTypeFromPath(image.localPath ?? '');
      if (!mimeType.startsWith('image/')) {
        throw new Error(`Unsupported generation image MIME type: ${mimeType}`);
      }
      return {
        mimeType,
        base64: data.toString('base64'),
        bytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
      };
    }),
  );
}

function mimeTypeFromPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return '';
  }
}

function buildAnthropicRequest(
  input: GantryGenerationInput,
  images: readonly ResolvedImage[],
  model: string,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [
    ...(input.content.text ? [{ type: 'text', text: input.content.text }] : []),
    ...images.map((image) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType,
        data: image.base64,
      },
    })),
  ];
  return cleanRecord({
    model,
    max_tokens: input.maxOutputTokens ?? 4096,
    system: input.promptCache
      ? [
          {
            type: 'text',
            text: input.system,
            cache_control: {
              type: 'ephemeral',
              ttl: input.promptCache.ttl ?? '5m',
            },
          },
        ]
      : input.system,
    messages: [{ role: 'user', content }],
    temperature: input.temperature,
    output_config:
      input.responseFormat?.type === 'json_schema'
        ? {
            format: {
              type: 'json_schema',
              schema: input.responseFormat.schema,
            },
            ...(normalizeAnthropicEffort(input.thinking?.effort)
              ? { effort: normalizeAnthropicEffort(input.thinking?.effort) }
              : {}),
          }
        : normalizeAnthropicEffort(input.thinking?.effort)
          ? { effort: normalizeAnthropicEffort(input.thinking?.effort) }
          : undefined,
    thinking:
      input.thinking?.budgetTokens && input.thinking.budgetTokens > 0
        ? { type: 'enabled', budget_tokens: input.thinking.budgetTokens }
        : undefined,
  });
}

function buildGeminiRequest(
  input: GantryGenerationInput,
  images: readonly ResolvedImage[],
  model: string,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [
    ...(input.content.text ? [{ type: 'text', text: input.content.text }] : []),
    ...images.map((image) => ({
      type: 'image_url',
      image_url: {
        url: `data:${image.mimeType};base64,${image.base64}`,
      },
    })),
  ];
  const thinkingConfig = cleanRecord({
    thinking_level: normalizeGeminiThinkingLevel(input.thinking?.effort),
    thinking_budget: input.thinking?.budgetTokens ?? undefined,
  });
  return cleanRecord({
    model,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content },
    ],
    max_completion_tokens: input.maxOutputTokens,
    temperature: input.temperature,
    response_format:
      input.responseFormat?.type === 'json_schema'
        ? {
            type: 'json_schema',
            json_schema: {
              name: input.responseFormat.name,
              schema: input.responseFormat.schema,
              strict: input.responseFormat.strict ?? true,
            },
          }
        : input.responseFormat?.type === 'text'
          ? { type: 'text' }
          : undefined,
    extra_body:
      Object.keys(thinkingConfig).length > 0
        ? { google: { thinking_config: thinkingConfig } }
        : undefined,
  });
}

function normalizeAnthropicEffort(
  effort: GantryGenerationInput['thinking'] extends infer _T
    ? 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | undefined
    : never,
): 'low' | 'medium' | 'high' | 'max' | undefined {
  return effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'max'
    ? effort
    : undefined;
}

function normalizeGeminiThinkingLevel(
  effort: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | undefined,
): 'minimal' | 'low' | 'medium' | 'high' | undefined {
  if (effort === 'minimal' || effort === 'low' || effort === 'medium') {
    return effort;
  }
  if (effort === 'high' || effort === 'max') return 'high';
  return undefined;
}

function buildObservabilityHeader(
  input: GantryGenerationInput,
  provider: GantryGenerationProvider,
  configuredModel: string,
  images: readonly ResolvedImage[],
): string | null {
  const parentContext = readActiveParentContext();
  if (!input.observability && !parentContext) return null;
  const payload = cleanRecord({
    ...(input.observability ?? {}),
    operationName: input.operationName,
    provider,
    configuredModel,
    ...parentContext,
    imageMetadata: images.map((image) => ({
      mimeType: image.mimeType,
      bytes: image.bytes,
      sha256: image.sha256,
    })),
  });
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_OBSERVABILITY_HEADER_BYTES) {
    throw new Error('Gantry observability context exceeds 16 KiB.');
  }
  return Buffer.from(encoded, 'utf8').toString('base64url');
}

function readActiveParentContext(): Record<string, string> | null {
  try {
    const traceId = getActiveTraceId();
    const spanId = getActiveSpanId();
    if (!traceId || !spanId) return null;
    if (!/^[0-9a-f]{32}$/iu.test(traceId) || !/^[0-9a-f]{16}$/iu.test(spanId)) {
      return null;
    }
    return {
      parentTraceId: traceId.toLowerCase(),
      parentSpanId: spanId.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function parseAnthropicResult(
  payload: Record<string, unknown>,
): GantryGenerationResult {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .map((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('');
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const inputTokens = readNumber(usage.input_tokens);
  const outputTokens = readNumber(usage.output_tokens);
  const cacheReadInputTokens = readNumber(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = readNumber(
    usage.cache_creation_input_tokens,
  );
  return {
    text,
    responseId: readString(payload.id),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: sumUsageTokens(
        inputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        outputTokens,
      ),
      cacheReadInputTokens,
      cacheCreationInputTokens,
      reasoningOutputTokens: null,
    },
    rawResponse: payload,
  };
}

function parseGeminiResult(
  payload: Record<string, unknown>,
): GantryGenerationResult {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(first.message) ? first.message : {};
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const details = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  const promptTokens = readNumber(usage.prompt_tokens);
  const cacheReadInputTokens =
    readNumber(details.cached_tokens) ??
    readNumber(usage.cachedContentTokenCount);
  const inputTokens = subtractTokenSubset(promptTokens, cacheReadInputTokens);
  const completionTokens = readNumber(usage.completion_tokens);
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const openAiReasoningTokens = readNumber(completionDetails.reasoning_tokens);
  const googleReasoningTokens = readNumber(usage.thoughtsTokenCount);
  const reasoningOutputTokens = openAiReasoningTokens ?? googleReasoningTokens;
  const outputTokens = openAiReasoningTokens
    ? subtractTokenSubset(completionTokens, openAiReasoningTokens)
    : completionTokens;
  return {
    text: readString(message.content) ?? '',
    responseId: readString(payload.id),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: sumUsageTokens(
        inputTokens,
        cacheReadInputTokens,
        outputTokens,
        reasoningOutputTokens,
      ),
      cacheReadInputTokens,
      cacheCreationInputTokens: null,
      reasoningOutputTokens,
    },
    rawResponse: payload,
  };
}

function subtractTokenSubset(
  inclusive: number | null,
  subset: number | null,
): number | null {
  if (inclusive === null) return null;
  return Math.max(0, inclusive - (subset ?? 0));
}

function sumUsageTokens(...values: Array<number | null>): number | null {
  const defined = values.filter((value): value is number => value !== null);
  return defined.length > 0
    ? defined.reduce((total, value) => total + value, 0)
    : null;
}

function generationHttpError(
  response: Response,
  payload: Record<string, unknown>,
  responseText: string,
): GantryGenerationError {
  const error = isRecord(payload.error) ? payload.error : payload;
  const message =
    readString(error.message) ??
    readString(payload.message) ??
    responseText.slice(0, 500) ??
    `Gantry LLM request failed with HTTP ${response.status}.`;
  return new GantryGenerationError({
    message,
    statusCode: response.status,
    code: readString(error.code) ?? readString(payload.code),
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    providerRequestId:
      response.headers.get('request-id') ??
      response.headers.get('x-request-id') ??
      readString(payload.request_id),
  });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function parseRecord(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
