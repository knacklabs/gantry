import {
  initializeGantryLangfuseTracingFromEnv,
  observeGantryModelCall,
  type GantryObservabilityContext,
} from '@cawstudios/agent-gantry';
import type { DirectLlmPromptCacheDiagnostics } from './llm-prompt-cache.js';

const OBSERVABILITY_HEADER = 'x-gantry-observability-context';
const MAX_JSON_INSPECTION_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_PREVIEW_CHARS = 1000;

let initialization: Promise<boolean> | null = null;

export type DirectLlmObservationContext = {
  readonly operationName: string;
  readonly modelCallType: 'generation' | 'rerank' | 'ocr' | 'agent_step';
  readonly attempt?: number;
  readonly observability: GantryObservabilityContext | null;
  readonly metadata: Record<string, unknown>;
  readonly parentSpanContext?: {
    readonly traceId: string;
    readonly spanId: string;
  };
};

export type DirectLlmResponseInspection = {
  readonly statusCode: number;
  readonly responseId: string | null;
  readonly outputPreview: string;
  readonly usageDetails?: Record<string, number>;
};

export async function initializeDirectLlmObservability(): Promise<void> {
  initialization ??= initializeGantryLangfuseTracingFromEnv().catch(
    () => false,
  );
  await initialization;
}

export function readDirectLlmObservationContext(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): DirectLlmObservationContext {
  const encoded = singleHeader(headers[OBSERVABILITY_HEADER]);
  const decoded = encoded ? decodeHeader(encoded) : null;
  const metadata = isRecord(decoded?.metadata) ? decoded.metadata : {};
  const operationName =
    readString(decoded?.operationName) ?? 'direct_llm.invoke';
  const modelCallType =
    decoded?.modelCallType === 'rerank' ||
    decoded?.modelCallType === 'ocr' ||
    decoded?.modelCallType === 'agent_step'
      ? decoded.modelCallType
      : 'generation';
  const attempt = readPositiveInteger(decoded?.attempt);
  const parentSpanContext = readParentSpanContext(decoded);
  return {
    operationName,
    modelCallType,
    ...(attempt ? { attempt } : {}),
    ...(parentSpanContext ? { parentSpanContext } : {}),
    observability: decoded
      ? {
          flowId: readString(decoded.flowId) ?? readString(metadata.flow_id),
          flowType:
            readString(decoded.flowType) ?? readString(metadata.flow_type),
          flowStage:
            readString(decoded.flowStage) ?? readString(metadata.flow_stage),
          sessionId:
            readString(decoded.sessionId) ?? readString(metadata.session_id),
          userId: readString(decoded.userId),
          costCategory:
            readString(decoded.costCategory) ??
            readString(metadata.cost_category),
          costStage:
            readString(decoded.costStage) ?? readString(metadata.cost_stage),
          tags: readStringArray(decoded.tags),
          metadata,
        }
      : null,
    metadata: {
      ...metadata,
      service_name: readString(decoded?.serviceName) ?? 'gantry-core',
      ...(Array.isArray(decoded?.imageMetadata)
        ? { image_metadata: decoded.imageMetadata }
        : {}),
    },
  };
}

export async function observeDirectLlmRequest<
  TOutput extends DirectLlmResponseInspection,
>(
  input: {
    readonly context: DirectLlmObservationContext;
    readonly provider: string;
    readonly model: string;
    readonly modelParameters: Record<string, string | number>;
    readonly inputSummary: Record<string, unknown>;
    readonly promptCache: DirectLlmPromptCacheDiagnostics;
  },
  operation: () => Promise<TOutput>,
): Promise<TOutput> {
  await initializeDirectLlmObservability();
  return await observeGantryModelCall(
    {
      operationName: input.context.operationName,
      taskType: readString(input.context.metadata.task_type),
      modelCallType: input.context.modelCallType,
      provider: input.provider,
      model: input.model,
      attempt: input.context.attempt,
      parentSpanContext: input.context.parentSpanContext,
      input: input.inputSummary,
      output: (result: TOutput) => result.outputPreview,
      usageDetails: (result: TOutput) => result.usageDetails,
      modelParameters: input.modelParameters,
      metadata: {
        ...input.context.metadata,
        prompt_cache_enabled: input.promptCache.enabled,
        prompt_cache_mode: input.promptCache.mode,
        prompt_cache_ttl: input.promptCache.ttl,
        prompt_cache_prefix_hash: input.promptCache.prefixHash,
        prompt_cache_prefix_chars: input.promptCache.prefixChars,
        prompt_cache_breakpoint_count: input.promptCache.breakpointCount,
      },
      resultMetadata: (result: TOutput) => ({
        status: result.statusCode >= 400 ? 'error' : 'success',
        http_status: result.statusCode,
        response_id: result.responseId,
        ...cacheUsageMetadata(result.usageDetails),
      }),
      observability: input.context.observability,
    },
    operation,
  );
}

export class DirectLlmResponseInspector {
  private readonly decoder = new TextDecoder();
  private readonly jsonChunks: Uint8Array[] = [];
  private jsonBytes = 0;
  private ssePending = '';
  private outputPreview = '';
  private responseId: string | null = null;
  private usageDetails: Record<string, number> | undefined;

  constructor(private readonly contentType: string) {}

  inspect(chunk: Uint8Array): void {
    if (this.contentType.includes('text/event-stream')) {
      this.inspectSse(this.decoder.decode(chunk, { stream: true }));
      return;
    }
    if (this.jsonBytes + chunk.byteLength <= MAX_JSON_INSPECTION_BYTES) {
      this.jsonChunks.push(chunk.slice());
      this.jsonBytes += chunk.byteLength;
    }
  }

  finish(statusCode: number): DirectLlmResponseInspection {
    if (this.contentType.includes('text/event-stream')) {
      this.inspectSse(this.decoder.decode());
      if (this.ssePending) this.inspectSseLine(this.ssePending);
    } else if (this.jsonChunks.length > 0) {
      const bytes = Buffer.concat(
        this.jsonChunks.map((chunk) => Buffer.from(chunk)),
      );
      this.inspectPayload(parseRecord(bytes.toString('utf8')));
    }
    return {
      statusCode,
      responseId: this.responseId,
      outputPreview: this.outputPreview,
      usageDetails:
        statusCode >= 400
          ? {
              input: 0,
              output: 0,
              total: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            }
          : this.usageDetails,
    };
  }

  private inspectSse(text: string): void {
    this.ssePending += text;
    const lines = this.ssePending.split(/\r?\n/u);
    this.ssePending = lines.pop() ?? '';
    for (const line of lines) this.inspectSseLine(line);
  }

  private inspectSseLine(line: string): void {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    this.inspectPayload(parseRecord(data));
  }

  private inspectPayload(payload: Record<string, unknown>): void {
    const message = isRecord(payload.message) ? payload.message : null;
    this.responseId =
      readString(payload.id) ??
      readString(payload.responseId) ??
      readString(message?.id) ??
      this.responseId;
    const text = extractOutputText(payload);
    if (text && this.outputPreview.length < MAX_OUTPUT_PREVIEW_CHARS) {
      this.outputPreview = `${this.outputPreview}${text}`.slice(
        0,
        MAX_OUTPUT_PREVIEW_CHARS,
      );
    }
    const usage =
      extractUsage(payload) ?? (message ? extractUsage(message) : undefined);
    if (usage) {
      this.usageDetails = withReconciledUsageTotal({
        ...this.usageDetails,
        ...usage,
      });
    }
  }
}

export function summarizeDirectLlmInput(body: Buffer): Record<string, unknown> {
  const payload = parseRecord(body.toString('utf8'));
  return {
    system_chars: countText(payload.system),
    content_chars: countText(payload.messages),
    message_count: Array.isArray(payload.messages)
      ? payload.messages.length
      : 0,
    image_count:
      countType(payload.messages, 'image') +
      countType(payload.messages, 'image_url'),
    has_output_schema: Boolean(
      payload.output_config || payload.response_format,
    ),
  };
}

function decodeHeader(value: string): Record<string, unknown> | null {
  try {
    return parseRecord(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function extractUsage(
  payload: Record<string, unknown>,
): Record<string, number> | undefined {
  const usage = isRecord(payload.usage) ? payload.usage : null;
  if (!usage) return undefined;
  const details = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const cacheRead =
    readNumber(usage.cache_read_input_tokens) ??
    readNumber(details.cached_tokens) ??
    readNumber(usage.cachedContentTokenCount) ??
    readNumber(usage.cached_content_token_count) ??
    readNumber(usage.total_cached_tokens);
  const cacheCreation = readNumber(usage.cache_creation_input_tokens);
  const anthropicInput = readNumber(usage.input_tokens);
  const promptTokens = readNumber(usage.prompt_tokens);
  const inputTokens =
    anthropicInput ?? subtractTokenSubset(promptTokens, cacheRead);
  const rawOutputTokens =
    readNumber(usage.output_tokens) ?? readNumber(usage.completion_tokens);
  const openAiReasoning = readNumber(completionDetails.reasoning_tokens);
  const googleReasoning = readNumber(usage.thoughtsTokenCount);
  const reasoningOutput = openAiReasoning ?? googleReasoning;
  const outputTokens = openAiReasoning
    ? subtractTokenSubset(rawOutputTokens, openAiReasoning)
    : rawOutputTokens;
  return compactNumbers({
    input: inputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    output: outputTokens,
    reasoning_output: reasoningOutput,
    total: sumDefinedUsage(
      inputTokens,
      cacheRead,
      cacheCreation,
      outputTokens,
      reasoningOutput,
    ),
  });
}

function cacheUsageMetadata(
  usage: Record<string, number> | undefined,
): Record<string, number> {
  const cacheRead = usage?.cache_read_input_tokens ?? usage?.cached_input ?? 0;
  const cacheCreation =
    usage?.cache_creation_input_tokens ?? usage?.cache_creation_input ?? 0;
  const inputTokens = usage?.input ?? 0;
  const denominator = inputTokens + cacheRead + cacheCreation;
  return {
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    cached_input_tokens: cacheRead,
    cache_hit_ratio: denominator > 0 ? Math.min(1, cacheRead / denominator) : 0,
  };
}

function readParentSpanContext(
  decoded: Record<string, unknown> | null,
): { readonly traceId: string; readonly spanId: string } | null {
  const traceId = readString(decoded?.parentTraceId)?.toLowerCase();
  const spanId = readString(decoded?.parentSpanId)?.toLowerCase();
  if (!traceId || !spanId) return null;
  if (!/^[0-9a-f]{32}$/u.test(traceId) || !/^[0-9a-f]{16}$/u.test(spanId)) {
    return null;
  }
  return { traceId, spanId };
}

function subtractTokenSubset(
  inclusive: number | undefined,
  subset: number | undefined,
): number | undefined {
  return inclusive === undefined
    ? undefined
    : Math.max(0, inclusive - (subset ?? 0));
}

function sumDefinedUsage(
  ...values: readonly (number | undefined)[]
): number | undefined {
  const defined = values.filter(
    (value): value is number => value !== undefined,
  );
  return defined.length > 0
    ? defined.reduce((total, value) => total + value, 0)
    : undefined;
}

function withReconciledUsageTotal(
  usage: Record<string, number>,
): Record<string, number> {
  const { total: _reportedTotal, ...buckets } = usage;
  return {
    ...buckets,
    total: Object.values(buckets).reduce((sum, value) => sum + value, 0),
  };
}

function extractOutputText(payload: Record<string, unknown>): string {
  const delta = isRecord(payload.delta) ? payload.delta : null;
  if (delta && typeof delta.text === 'string') return delta.text;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const direct = content
    .map((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('');
  if (direct) return direct;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  const message = choice && isRecord(choice.message) ? choice.message : null;
  const choiceDelta = choice && isRecord(choice.delta) ? choice.delta : null;
  return typeof message?.content === 'string'
    ? message.content
    : typeof choiceDelta?.content === 'string'
      ? choiceDelta.content
      : '';
}

function countText(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value))
    return value.reduce((sum, entry) => sum + countText(entry), 0);
  if (!isRecord(value)) return 0;
  return Object.entries(value).reduce(
    (sum, [key, entry]) =>
      sum + (key === 'data' || key === 'url' ? 0 : countText(entry)),
    0,
  );
}

function countType(value: unknown, type: string): number {
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (sum, entry) => sum + countType(entry, type),
      0,
    );
  }
  if (!isRecord(value)) return 0;
  return (
    (value.type === type ? 1 : 0) +
    Object.values(value).reduce<number>(
      (sum, entry) => sum + countType(entry, type),
      0,
    )
  );
}

function compactNumbers(
  input: Record<string, number | undefined>,
): Record<string, number> | undefined {
  const output = Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, number] => entry[1] !== undefined,
    ),
  );
  return Object.keys(output).length > 0 ? output : undefined;
}

function parseRecord(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function singleHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  return strings.length > 0 ? strings : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = readNumber(value);
  return number && Number.isInteger(number) && number > 0 ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
