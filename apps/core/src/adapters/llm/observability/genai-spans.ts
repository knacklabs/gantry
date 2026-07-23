import { SpanStatusCode, type Span } from '@opentelemetry/api';

import { logger } from '../../../infrastructure/logging/logger.js';
import { normalizeModelUsage } from '../../../shared/model-usage.js';
import type { NormalizedModelUsage } from '../../../shared/model-catalog.js';
import {
  ATTR_COMPLETION,
  ATTR_PROMPT,
  boundedContent,
  MAX_ATTRIBUTE_CHARS,
  TRACE_CONTENT_MAX_CHARS,
  childContextFor,
  contentCaptureEnabled,
  getTurnSpan,
  registerDelegationToolSpan,
  registerTurnSpanEndCallback,
  settleDelegationToolSpan,
  tracer,
} from '../../../infrastructure/observability/tracing.js';
import {
  createSseAccumulator,
  type SseAccumulatorResult,
  type SseToolCall,
  type SseStreamKind,
} from './sse-accumulator.js';
import {
  createSseFrameSplitter,
  isOpenAiUsageOnlyFrame,
} from './sse-frame-splitter.js';
import {
  ATTR_INPUT_MESSAGES,
  ATTR_OUTPUT_MESSAGES,
  MAX_TOOL_CALLS,
  numeric,
  promptMessages,
  providerNameFor,
  providerSystemFor,
  responseAssistantMessages,
  responseToolCalls,
  setMessageAttributes,
  setNormalizedUsageAttributes,
  setUsageAttributes,
  type ToolCall,
} from './genai-message-attributes.js';
import {
  failPendingToolSpans,
  finishPendingToolSpans,
  pendingToolsByRun,
  startPendingToolSpans,
  streamedToolCalls,
} from './genai-tool-spans.js';

let pendingTracer: ReturnType<typeof tracer>;

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
    status?: number,
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

// gen_ai.system identifies the PROVIDER (semconv well-known values where
// they exist); `kind` is only the wire format used for parsing.
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
  if (pendingTracer !== activeTracer) {
    pendingTracer = activeTracer;
    pendingToolsByRun.clear();
  }
  let startedSpan: Span | undefined;
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
    if (runId) {
      finishPendingToolSpans(runId, kind, request, captureContent);
    }
    const parent = runId ? getTurnSpan(runId) : undefined;
    // Span names bypass the attribute length limit; model comes from an
    // untrusted request body.
    const span = (startedSpan = activeTracer.startSpan(
      `chat ${(requestModel ?? input.providerId).slice(0, 128)}`,
      {
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': providerNameFor(input.providerId),
          'gen_ai.system': providerSystemFor(input.providerId),
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
    ));
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
      const messages = promptMessages(request);
      if (messages.length > 0) {
        setMessageAttributes(
          span,
          ATTR_PROMPT,
          ATTR_INPUT_MESSAGES,
          messages,
          kind,
        );
      }
    }

    const accumulator =
      isStreaming && kind
        ? createSseAccumulator(kind, captureContent)
        : undefined;
    let tapUsed = false;
    let sawFirstChunk = false;
    let streamStatus: number | undefined;
    const earlyRegisteredToolCallIds = new Set<string>();

    const registerCompletedStreamToolCalls = () => {
      if (!accumulator?.takeToolCallsReady()) return;
      if (
        !runId ||
        streamStatus === undefined ||
        streamStatus < 200 ||
        streamStatus >= 300
      ) {
        return;
      }
      const streamed = accumulator.result();
      if (streamed.errorMessage) return;
      const liveParent = getTurnSpan(runId);
      if (!liveParent) return;
      const complete = streamedToolCalls(kind, streamed).filter(
        (call) => call.complete && !earlyRegisteredToolCallIds.has(call.id),
      );
      if (complete.length === 0) return;
      startPendingToolSpans({
        runId,
        parent: liveParent,
        activeTracer,
        toolCalls: complete,
        captureContent,
      });
      const pending = pendingToolsByRun.get(runId);
      for (const call of complete) {
        if (pending?.has(call.id)) earlyRegisteredToolCallIds.add(call.id);
      }
    };

    const markFirstChunk = () => {
      if (!sawFirstChunk) {
        sawFirstChunk = true;
        try {
          span.addEvent('gantry.first_response_byte');
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
              registerCompletedStreamToolCalls();
            } catch {
              // fail-open
            }
            return chunk;
          },
          flush: () => {
            try {
              accumulator?.push(Buffer.from('\n\n'));
              registerCompletedStreamToolCalls();
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
          registerCompletedStreamToolCalls();
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
        let assistantMessages: Record<string, unknown>[] = [];
        let toolCalls: ToolCall[] = [];
        let finishReasons: string[] = [];
        let streamErrorMessage: string | undefined;
        if (tapUsed && accumulator) {
          const streamed = accumulator.result();
          usage = streamed.usage;
          responseModel = streamed.model;
          toolCalls = streamedToolCalls(kind, streamed);
          if (streamed.assistantMessages) {
            assistantMessages = streamed.assistantMessages;
          } else if (streamed.assistantMessage) {
            assistantMessages = [streamed.assistantMessage];
          } else if (streamed.completionText) {
            assistantMessages = [
              {
                role: 'assistant',
                content: streamed.completionText,
                ...(streamed.finishReason
                  ? { finish_reason: streamed.finishReason }
                  : {}),
              },
            ];
          }
          finishReasons =
            streamed.finishReasons ??
            (streamed.finishReason ? [streamed.finishReason] : []);
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
          assistantMessages = captureContent
            ? responseAssistantMessages(kind, response)
            : [];
          toolCalls = responseToolCalls(kind, response);
          if (typeof response.stop_reason === 'string') {
            finishReasons = [response.stop_reason];
          } else {
            finishReasons = (
              (response.choices as Record<string, unknown>[] | undefined) ?? []
            )
              .slice(0, MAX_TOOL_CALLS)
              .flatMap((choice) =>
                typeof choice.finish_reason === 'string'
                  ? [choice.finish_reason]
                  : [],
              );
          }
          if (typeof response.id === 'string') {
            span.setAttribute('gen_ai.response.id', response.id);
          }
        }
        if (responseModel) {
          span.setAttribute('gen_ai.response.model', responseModel);
        }
        if (finishReasons.length > 0) {
          span.setAttribute('gen_ai.response.finish_reasons', finishReasons);
        }
        if (usage) setUsageAttributes(span, usage, kind);
        const normalized =
          result.normalizedUsage ??
          (usage
            ? normalizeModelUsage({
                message: { model: responseModel, usage },
                fallbackModel: responseModel ?? requestModel,
              })
            : undefined);
        if (normalized) {
          setNormalizedUsageAttributes(span, normalized, kind, usage);
        }
        if (typeof normalized?.estimatedCostUsd === 'number') {
          span.setAttribute('gen_ai.usage.cost', normalized.estimatedCostUsd);
        }
        if (captureContent && assistantMessages.length > 0) {
          setMessageAttributes(
            span,
            ATTR_COMPLETION,
            ATTR_OUTPUT_MESSAGES,
            assistantMessages,
            kind,
          );
        }
        // Provider and transport errors can arrive after valid-looking tool
        // fragments. Only a successful terminal tool-call response means a
        // tool execution could actually follow on the next request.
        const providerError = streamErrorMessage
          ? captureContent
            ? boundedContent(streamErrorMessage)
            : 'provider stream error'
          : undefined;
        const errorMessage = result.errorMessage
          ? boundedContent(result.errorMessage)
          : providerError;
        if (runId && errorMessage && earlyRegisteredToolCallIds.size > 0) {
          failPendingToolSpans(runId, earlyRegisteredToolCallIds);
        }
        const liveParent = runId ? getTurnSpan(runId) : undefined;
        const completeToolCalls = toolCalls.filter(
          (call) => call.complete && !earlyRegisteredToolCallIds.has(call.id),
        );
        if (
          runId &&
          liveParent &&
          result.status >= 200 &&
          result.status < 300 &&
          !errorMessage &&
          completeToolCalls.length > 0
        ) {
          startPendingToolSpans({
            runId,
            parent: liveParent,
            activeTracer,
            toolCalls: completeToolCalls,
            captureContent,
          });
        }
        // streamErrorMessage is provider-sourced and may echo request
        // content; with content capture off, record a stable label instead.
        // result.errorMessage is host/gateway-sourced (timeouts, statusText).
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
      streamTapFor: (contentType, status) => {
        // Media types are case-insensitive (e.g. Text/Event-Stream).
        if (
          !isStreaming ||
          !contentType?.toLowerCase().includes('text/event-stream')
        ) {
          return undefined;
        }
        if (status !== undefined) streamStatus = status;
        cachedTap ??= buildStreamTap();
        return cachedTap;
      },
      finish,
    };
  } catch (err) {
    try {
      startedSpan?.end();
    } catch {
      // fail-open
    }
    logger.warn({ err: String(err) }, 'Failed to observe gateway call');
    return undefined;
  }
}
