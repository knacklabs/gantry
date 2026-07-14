import { SpanStatusCode, type Span } from '@opentelemetry/api';

import { logger } from '../../../infrastructure/logging/logger.js';
import { normalizeModelUsage } from '../../../shared/model-usage.js';
import type { NormalizedModelUsage } from '../../../shared/model-catalog.js';
import {
  ATTR_COMPLETION,
  ATTR_PROMPT,
  boundedContent,
  boundedJsonArray,
  childContextFor,
  contentCaptureEnabled,
  getTurnSpan,
  tracer,
} from '../../../infrastructure/observability/tracing.js';
import {
  createSseAccumulator,
  createSseFrameSplitter,
  isOpenAiUsageOnlyFrame,
  type SseStreamKind,
} from './sse-accumulator.js';

export interface GatewayCallTokenContext {
  appId?: unknown;
  agentId?: unknown;
  runId?: unknown;
  jobId?: unknown;
  conversationId?: unknown;
  threadId?: unknown;
  apiKeyId?: string;
}

export interface GatewayStreamTap {
  transform: (chunk: Buffer) => Buffer;
  flush: () => Buffer;
}

export interface GatewayCallObservation {
  requestBody: Buffer;
  isStreaming: boolean;
  // Only engages for actual SSE responses — a streaming REQUEST can still get
  // a plain-JSON error body back, which the frame-aligned tap must not touch.
  streamTapFor: (
    contentType: string | null | undefined,
  ) => GatewayStreamTap | undefined;
  finish: (input: {
    status: number;
    responseJson?: unknown;
    normalizedUsage?: NormalizedModelUsage;
    errorMessage?: string;
  }) => void;
}

function componentFor(token: GatewayCallTokenContext): string {
  if (token.apiKeyId) return 'llm-api';
  const runId = token.runId === undefined ? '' : String(token.runId);
  if (runId.startsWith('memory-query:')) return 'memory';
  if (runId.startsWith('permission-classifier:')) {
    return 'permission-classifier';
  }
  return 'unattributed';
}

function streamKindFor(pathname: string): SseStreamKind | undefined {
  if (pathname.includes('/chat/completions')) return 'openai';
  if (pathname.includes('/messages') && !pathname.includes('/count_tokens')) {
    return 'anthropic';
  }
  return undefined;
}

// Non-generation endpoints the gateway also proxies; tracing them as `chat`
// generations would corrupt call counts and usage rollups. Untraced in v1.
// Suffix-matched: substrings would false-positive on dynamic path segments
// (e.g. a Vertex project named `embeddings-prod`).
const NON_GENERATION_SUFFIXES = [
  '/embeddings',
  '/count_tokens',
  '/moderations',
  '/rerank',
];

// stream_options.include_usage is only injected for providers verified to
// accept it — an endpoint that rejects unknown fields would turn a valid
// call into a 4xx just because tracing is on. Everything else relies on the
// caller opting in (LangChain's ChatOpenAI does by default), and OpenRouter
// returns its usage frame natively without the flag.
const INJECT_STREAM_USAGE_PROVIDERS = new Set(['openai']);

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function promptJson(request: Record<string, unknown>): string | undefined {
  const messages = Array.isArray(request.messages)
    ? (request.messages as Record<string, unknown>[])
    : [];
  const entries: { role: string; content: string }[] = [];
  const system = request.system;
  if (typeof system === 'string') {
    entries.push({ role: 'system', content: boundedContent(system) });
  } else if (Array.isArray(system)) {
    entries.push({
      role: 'system',
      content: boundedContent(JSON.stringify(system)),
    });
  }
  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const content =
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? '');
    entries.push({ role, content: boundedContent(content) });
  }
  return entries.length > 0 ? boundedJsonArray(entries) : undefined;
}

function completionJson(content: string): string {
  return boundedJsonArray([
    { role: 'assistant', content: boundedContent(content) },
  ]);
}

function responseCompletionText(
  kind: SseStreamKind | undefined,
  response: Record<string, unknown>,
): string | undefined {
  if (kind === 'anthropic' && Array.isArray(response.content)) {
    const text = (response.content as Record<string, unknown>[])
      .filter((block) => block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('');
    return text || JSON.stringify(response.content);
  }
  if (kind === 'openai') {
    const choice = (
      response.choices as Record<string, unknown>[] | undefined
    )?.[0];
    const message = choice?.message as { content?: unknown } | undefined;
    if (typeof message?.content === 'string') return message.content;
  }
  return undefined;
}

function setUsageAttributes(span: Span, usage: Record<string, unknown>): void {
  const input = numeric(usage.input_tokens) ?? numeric(usage.prompt_tokens);
  const output =
    numeric(usage.output_tokens) ?? numeric(usage.completion_tokens);
  if (input !== undefined) {
    span.setAttribute('gen_ai.usage.input_tokens', input);
  }
  if (output !== undefined) {
    span.setAttribute('gen_ai.usage.output_tokens', output);
  }
  const total = numeric(usage.total_tokens);
  if (total !== undefined) {
    span.setAttribute('gen_ai.usage.total_tokens', total);
  }
  const cacheRead = numeric(usage.cache_read_input_tokens);
  if (cacheRead !== undefined) {
    span.setAttribute('gen_ai.usage.cache_read_input_tokens', cacheRead);
  }
  const cacheWrite = numeric(usage.cache_creation_input_tokens);
  if (cacheWrite !== undefined) {
    span.setAttribute('gen_ai.usage.cache_creation_input_tokens', cacheWrite);
  }
  const details = usage.prompt_tokens_details as
    | Record<string, unknown>
    | undefined;
  const cached = numeric(details?.cached_tokens);
  if (cached !== undefined) {
    span.setAttribute('gen_ai.usage.cached_tokens', cached);
  }
}

function setNormalizedUsageAttributes(
  span: Span,
  usage: NormalizedModelUsage,
): void {
  span.setAttribute('gen_ai.usage.input_tokens', usage.inputTokens);
  span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens);
  if (usage.cacheReadTokens > 0) {
    span.setAttribute(
      'gen_ai.usage.cache_read_input_tokens',
      usage.cacheReadTokens,
    );
  }
  if (usage.cacheWriteTokens > 0) {
    span.setAttribute(
      'gen_ai.usage.cache_creation_input_tokens',
      usage.cacheWriteTokens,
    );
  }
}

function injectIncludeUsage(
  request: Record<string, unknown>,
): Buffer | undefined {
  const streamOptions = request.stream_options as
    | Record<string, unknown>
    | undefined;
  if (streamOptions && Object.hasOwn(streamOptions, 'include_usage')) {
    return undefined;
  }
  try {
    return Buffer.from(
      JSON.stringify({
        ...request,
        stream_options: { ...(streamOptions ?? {}), include_usage: true },
      }),
      'utf8',
    );
  } catch {
    return undefined;
  }
}

export function observeGatewayCall(input: {
  token: GatewayCallTokenContext;
  providerId: string;
  upstreamUrl: URL;
  requestBody: Buffer;
}): GatewayCallObservation | undefined {
  const activeTracer = tracer();
  if (!activeTracer) return undefined;
  try {
    let request: Record<string, unknown> = {};
    try {
      request = JSON.parse(input.requestBody.toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      // Non-JSON body: still trace timing/status.
    }
    if (
      NON_GENERATION_SUFFIXES.some((suffix) =>
        input.upstreamUrl.pathname.endsWith(suffix),
      )
    ) {
      return undefined;
    }
    const kind = streamKindFor(input.upstreamUrl.pathname);
    const isStreaming = request.stream === true;
    const requestModel =
      typeof request.model === 'string' ? request.model : undefined;
    const captureContent = contentCaptureEnabled();

    const runId =
      input.token.runId === undefined ? undefined : String(input.token.runId);
    const parent = runId ? getTurnSpan(runId) : undefined;
    const span = activeTracer.startSpan(
      `chat ${requestModel ?? input.providerId}`,
      {
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.system':
            kind === 'anthropic'
              ? 'anthropic'
              : kind === 'openai'
                ? 'openai'
                : input.providerId,
          ...(requestModel ? { 'gen_ai.request.model': requestModel } : {}),
          ...(numeric(request.max_tokens) !== undefined
            ? { 'gen_ai.request.max_tokens': numeric(request.max_tokens)! }
            : {}),
          ...(numeric(request.temperature) !== undefined
            ? { 'gen_ai.request.temperature': numeric(request.temperature)! }
            : {}),
          'server.address': input.upstreamUrl.host,
          'gantry.provider_id': input.providerId,
          ...(parent ? {} : { 'gantry.component': componentFor(input.token) }),
          ...(input.token.appId
            ? { 'gantry.app_id': String(input.token.appId) }
            : {}),
          ...(input.token.agentId
            ? { 'gantry.agent_id': String(input.token.agentId) }
            : {}),
          ...(runId ? { 'gantry.run_id': runId } : {}),
          ...(input.token.jobId
            ? { 'gantry.job_id': String(input.token.jobId) }
            : {}),
          ...(input.token.threadId
            ? { 'gantry.thread_id': String(input.token.threadId) }
            : {}),
          ...(input.token.conversationId
            ? { 'session.id': String(input.token.conversationId) }
            : {}),
        },
      },
      parent ? childContextFor(parent) : undefined,
    );
    // Sampled-out span: no observability data will export, so the request
    // must pass through byte-identical — no usage injection, no stream tap.
    if (!span.isRecording()) {
      span.end();
      return undefined;
    }
    let requestBody = input.requestBody;
    let injectedUsage = false;
    if (
      kind === 'openai' &&
      isStreaming &&
      INJECT_STREAM_USAGE_PROVIDERS.has(input.providerId)
    ) {
      const rewritten = injectIncludeUsage(request);
      if (rewritten) {
        requestBody = rewritten;
        injectedUsage = true;
      }
    }
    if (captureContent) {
      const prompt = promptJson(request);
      if (prompt) span.setAttribute(ATTR_PROMPT, prompt);
    }

    const accumulator =
      isStreaming && kind
        ? createSseAccumulator(kind, captureContent)
        : undefined;
    let tapUsed = false;
    let sawFirstChunk = false;

    const markFirstChunk = () => {
      if (!sawFirstChunk) {
        sawFirstChunk = true;
        try {
          span.addEvent('gen_ai.first_token');
        } catch {
          // fail-open
        }
      }
    };

    // In injectedUsage mode the tap must be frame-aligned so the synthetic
    // usage-only chunk (which the caller did not ask for) can be stripped
    // from the downstream stream. Frame delimiters are normalized to \n\n
    // on that path. Otherwise the tap is a pure byte pass-through.
    const buildStreamTap = (): GatewayStreamTap => {
      if (!injectedUsage || !accumulator) {
        return {
          transform: (chunk) => {
            tapUsed = true;
            markFirstChunk();
            try {
              accumulator?.push(chunk);
            } catch {
              // fail-open
            }
            return chunk;
          },
          flush: () => {
            try {
              accumulator?.push(Buffer.from('\n\n'));
            } catch {
              // fail-open
            }
            return Buffer.alloc(0);
          },
        };
      }
      const splitter = createSseFrameSplitter();
      // Once the splitter overflows (one giant unterminated frame), the tap
      // releases everything it buffered and degrades to raw pass-through —
      // bytes must never be withheld from the client.
      let rawPassThrough = false;
      const processFrames = (frames: string[]) => {
        const out: string[] = [];
        for (const frame of frames) {
          accumulator.pushFrame(frame);
          if (!isOpenAiUsageOnlyFrame(frame)) out.push(`${frame}\n\n`);
        }
        if (splitter.overflowed()) {
          rawPassThrough = true;
          out.push(splitter.takePending());
        }
        return Buffer.from(out.join(''), 'utf8');
      };
      return {
        transform: (chunk) => {
          tapUsed = true;
          markFirstChunk();
          if (rawPassThrough) return chunk;
          try {
            return processFrames(splitter.push(chunk));
          } catch {
            return chunk;
          }
        },
        flush: () => {
          if (rawPassThrough) return Buffer.alloc(0);
          try {
            return processFrames(splitter.flush());
          } catch {
            return Buffer.alloc(0);
          }
        },
      };
    };

    let finished = false;
    const finish: GatewayCallObservation['finish'] = (result) => {
      if (finished) return;
      finished = true;
      try {
        span.setAttribute('http.response.status_code', result.status);
        let usage: Record<string, unknown> | undefined;
        let responseModel: string | undefined;
        let completionText: string | undefined;
        let finishReason: string | undefined;
        let streamErrorMessage: string | undefined;
        if (tapUsed && accumulator) {
          const streamed = accumulator.result();
          usage = streamed.usage;
          responseModel = streamed.model;
          completionText = streamed.completionText;
          finishReason = streamed.finishReason;
          streamErrorMessage = streamed.errorMessage;
        } else if (
          result.responseJson &&
          typeof result.responseJson === 'object'
        ) {
          const response = result.responseJson as Record<string, unknown>;
          usage =
            response.usage && typeof response.usage === 'object'
              ? (response.usage as Record<string, unknown>)
              : undefined;
          responseModel =
            typeof response.model === 'string' ? response.model : undefined;
          completionText = responseCompletionText(kind, response);
          finishReason =
            typeof response.stop_reason === 'string'
              ? response.stop_reason
              : typeof (
                    response.choices as Record<string, unknown>[] | undefined
                  )?.[0]?.finish_reason === 'string'
                ? ((response.choices as Record<string, unknown>[])[0]
                    .finish_reason as string)
                : undefined;
          if (typeof response.id === 'string') {
            span.setAttribute('gen_ai.response.id', response.id);
          }
        }
        if (responseModel) {
          span.setAttribute('gen_ai.response.model', responseModel);
        }
        if (finishReason) {
          span.setAttribute('gen_ai.response.finish_reasons', [finishReason]);
        }
        if (usage) setUsageAttributes(span, usage);
        const normalized =
          result.normalizedUsage ??
          (usage
            ? normalizeModelUsage({
                message: { model: responseModel, usage },
                fallbackModel: responseModel ?? requestModel,
              })
            : undefined);
        if (normalized) setNormalizedUsageAttributes(span, normalized);
        if (typeof normalized?.estimatedCostUsd === 'number') {
          span.setAttribute('gen_ai.usage.cost', normalized.estimatedCostUsd);
        }
        if (captureContent && completionText) {
          span.setAttribute(ATTR_COMPLETION, completionJson(completionText));
        }
        const errorMessage = result.errorMessage ?? streamErrorMessage;
        if (result.status >= 400 || errorMessage) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
          if (errorMessage) {
            span.setAttribute('error.type', errorMessage);
          }
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'Failed to finalize LLM span');
      } finally {
        try {
          span.end();
        } catch {
          // fail-open
        }
      }
    };

    let cachedTap: GatewayStreamTap | undefined;
    return {
      requestBody,
      isStreaming,
      streamTapFor: (contentType) => {
        if (!isStreaming || !contentType?.includes('text/event-stream')) {
          return undefined;
        }
        cachedTap ??= buildStreamTap();
        return cachedTap;
      },
      finish,
    };
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to observe gateway call');
    return undefined;
  }
}
