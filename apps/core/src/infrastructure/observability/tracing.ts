import {
  context,
  diag,
  DiagLogLevel,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  defaultResource,
  resourceFromAttributes,
} from '@opentelemetry/resources';

import { logger } from '../logging/logger.js';

export interface TracingRuntimeConfig {
  enabled: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
  captureContent: boolean;
  sampleRate: number;
  environment?: string;
}

export const TRACE_CONTENT_MAX_CHARS = 16_000;

// Legacy gen_ai.prompt/gen_ai.completion keys are what both Langfuse and
// LangSmith map natively today; flip to gen_ai.input.messages /
// gen_ai.output.messages once both backends ingest the newer semconv.
export const ATTR_PROMPT = 'gen_ai.prompt';
export const ATTR_COMPLETION = 'gen_ai.completion';

interface TracingState {
  provider: NodeTracerProvider;
  tracer: Tracer;
  captureContent: boolean;
}

let state: TracingState | undefined;
const turnSpans = new Map<string, Span>();

export function parseOtlpHeaders(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key) headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function initTracing(
  config: TracingRuntimeConfig,
  testExporter?: SpanExporter,
): void {
  if (!config.enabled || state) return;
  const exporter =
    testExporter ??
    new OTLPTraceExporter({
      ...(config.endpoint ? { url: config.endpoint } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
    });
  const spanProcessor: SpanProcessor = testExporter
    ? new SimpleSpanProcessor(testExporter)
    : new BatchSpanProcessor(exporter);
  const provider = new NodeTracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({
        'service.name': 'gantry-runtime',
        ...(config.environment
          ? { 'deployment.environment.name': config.environment }
          : {}),
      }),
    ),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.sampleRate),
    }),
    spanLimits: { attributeValueLengthLimit: 32_768 },
    spanProcessors: [spanProcessor],
  });
  diag.setLogger(
    {
      verbose: () => {},
      debug: () => {},
      info: () => {},
      warn: (message) => logger.warn({ message }, 'OTel tracing'),
      error: (message) => logger.warn({ message }, 'OTel tracing error'),
    },
    DiagLogLevel.WARN,
  );
  state = {
    provider,
    tracer: provider.getTracer('gantry'),
    captureContent: config.captureContent,
  };
}

export async function shutdownTracing(): Promise<void> {
  const current = state;
  state = undefined;
  turnSpans.clear();
  if (!current) return;
  try {
    await current.provider.shutdown();
  } catch (err) {
    logger.warn({ err: String(err) }, 'OTel tracing shutdown failed');
  }
}

export function tracingEnabled(): boolean {
  return state !== undefined;
}

export function contentCaptureEnabled(): boolean {
  return state?.captureContent ?? false;
}

export function tracer(): Tracer | undefined {
  return state?.tracer;
}

export function getTurnSpan(runId: string): Span | undefined {
  return turnSpans.get(runId);
}

export function boundedContent(value: string): string {
  return value.length > TRACE_CONTENT_MAX_CHARS
    ? `${value.slice(0, TRACE_CONTENT_MAX_CHARS)}…[truncated]`
    : value;
}

export const MAX_ATTRIBUTE_CHARS = 32_768;
const TRUNCATION_SUFFIX = '…[truncated]';
const MIN_ENTRY_CONTENT = 256;

// Serialize message arrays to VALID JSON that fits the OTel attribute value
// limit — the SDK's own limit cuts mid-string, producing unparseable
// content, and JSON escaping (control chars → \uXXXX) can inflate bounded
// raw text past the limit. Geometric halving keeps this ~linear in the
// input size, unlike per-entry re-serialization.
export function boundedJsonArray(
  entries: { role: string; content: string }[],
): string {
  // Pass 1: geometric halving of oversized content (~linear overall).
  let serialized = JSON.stringify(entries);
  while (serialized.length > MAX_ATTRIBUTE_CHARS) {
    let shrunk = false;
    for (const entry of entries) {
      if (entry.content.length > MIN_ENTRY_CONTENT) {
        const base = entry.content.endsWith(TRUNCATION_SUFFIX)
          ? entry.content.slice(0, -TRUNCATION_SUFFIX.length)
          : entry.content;
        entry.content =
          base.slice(0, Math.floor(base.length / 2)) + TRUNCATION_SUFFIX;
        shrunk = true;
      }
    }
    if (!shrunk) break;
    serialized = JSON.stringify(entries);
  }
  if (serialized.length <= MAX_ATTRIBUTE_CHARS) return serialized;
  // Pass 2: too many short entries — keep the largest suffix (most recent
  // messages) that fits, in one O(n) walk; popping one entry per full
  // re-serialization would be quadratic on the request hot path.
  let budget = MAX_ATTRIBUTE_CHARS - 2;
  const kept: { role: string; content: string }[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const cost = JSON.stringify(entries[index]).length + 1;
    if (cost > budget) break;
    budget -= cost;
    kept.push(entries[index]!);
  }
  kept.reverse();
  return JSON.stringify(kept);
}

export interface TurnSpanHandle {
  traceId?: string;
  setInput: (content: string) => void;
  setOutput: (content: string) => void;
  end: (outcome: 'success' | 'error' | 'stopped', error?: string) => void;
}

const NOOP_TURN_SPAN: TurnSpanHandle = {
  setInput: () => {},
  setOutput: () => {},
  end: () => {},
};

export function startTurnSpan(input: {
  runId: string;
  appId?: string;
  agentId?: string;
  agentName: string;
  conversationId?: string;
  threadId?: string;
  jobId?: string;
  userId?: string;
  continuation?: boolean;
}): TurnSpanHandle {
  const current = state;
  if (!current) return NOOP_TURN_SPAN;
  try {
    const span = current.tracer.startSpan(`invoke_agent ${input.agentName}`, {
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': input.agentName,
        ...(input.agentId ? { 'gen_ai.agent.id': input.agentId } : {}),
        ...(input.conversationId ? { 'session.id': input.conversationId } : {}),
        ...(input.userId ? { 'user.id': input.userId } : {}),
        ...(input.appId ? { 'gantry.app_id': input.appId } : {}),
        'gantry.run_id': input.runId,
        ...(input.jobId ? { 'gantry.job_id': input.jobId } : {}),
        ...(input.threadId ? { 'gantry.thread_id': input.threadId } : {}),
        ...(input.continuation ? { 'gantry.continuation': true } : {}),
      },
    });
    turnSpans.set(input.runId, span);
    let ended = false;
    return {
      traceId: span.spanContext().traceId,
      setInput: (content) => {
        if (!ended && current.captureContent) {
          span.setAttribute(
            ATTR_PROMPT,
            boundedJsonArray([
              { role: 'user', content: boundedContent(content) },
            ]),
          );
        }
      },
      setOutput: (content) => {
        if (!ended && current.captureContent) {
          span.setAttribute(
            ATTR_COMPLETION,
            boundedJsonArray([
              { role: 'assistant', content: boundedContent(content) },
            ]),
          );
        }
      },
      end: (outcome, error) => {
        if (ended) return;
        ended = true;
        turnSpans.delete(input.runId);
        try {
          span.setAttribute('gantry.turn_outcome', outcome);
          if (outcome === 'error') {
            // Runner errors can echo prompt/result text; honor capture_content.
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error
                ? current.captureContent
                  ? boundedContent(error)
                  : 'agent turn failed'
                : undefined,
            });
          }
          span.end();
        } catch (err) {
          logger.warn({ err: String(err) }, 'Failed to end turn span');
        }
      },
    };
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to start turn span');
    return NOOP_TURN_SPAN;
  }
}

export function childContextFor(parent: Span) {
  return trace.setSpan(ROOT_CONTEXT, parent);
}

export { context, SpanStatusCode };
export type { Span };
