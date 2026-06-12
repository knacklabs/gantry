import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../../../shared/model-catalog.js';
import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
import { nowIso } from '../../../../shared/time/datetime.js';

// Pure normalizer: turns an async iterable of LangGraph `streamEvents` (v2)
// events into the provider-neutral runner output frame contract. Kept free of
// any network/SDK construction so it is unit-testable against a mocked stream.
//
// Behavior mirrors the Anthropic runner streaming contract:
//   - text token deltas are emitted as intermediate frames
//     { status:'success', result:<delta>, newSessionId } so channels stream;
//   - the final frame carries the accumulated assistant text (only when no
//     partial text was streamed, to avoid double-rendering), usage, and
//     contextUsage.
// usage_metadata (input_tokens/output_tokens) is accumulated across
// AIMessageChunks. Context-window figures come from the runtime model profile,
// never hardcoded.

export interface LangGraphStreamEvent {
  event: string;
  data?: {
    chunk?: unknown;
    output?: unknown;
  };
}

export interface ModelProfileSnapshot {
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface StreamNormalizerInput {
  events: AsyncIterable<LangGraphStreamEvent>;
  newSessionId: string;
  modelId?: string;
  modelProfile: ModelProfileSnapshot;
  emit: (frame: RunnerOutputFrame) => void;
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
}

export async function normalizeDeepAgentStream(
  input: StreamNormalizerInput,
): Promise<{ text: string; usage: UsageAccumulator }> {
  const usage: UsageAccumulator = { inputTokens: 0, outputTokens: 0 };
  let accumulatedText = '';
  let sawPartialText = false;

  for await (const event of input.events) {
    if (event.event === 'on_chat_model_stream') {
      const chunk = event.data?.chunk;
      accumulateUsageFromChunk(chunk, usage);
      const delta = textFromChunk(chunk);
      if (delta) {
        accumulatedText += delta;
        sawPartialText = true;
        input.emit({
          status: 'success',
          result: delta,
          newSessionId: input.newSessionId,
        });
      }
      continue;
    }
    if (event.event === 'on_chat_model_end') {
      accumulateUsageFromChunk(event.data?.output, usage);
    }
  }

  input.emit({
    status: 'success',
    result: sawPartialText ? null : accumulatedText || null,
    newSessionId: input.newSessionId,
    usage: normalizedUsage(usage, input.modelId),
    contextUsage: contextUsageSnapshot(
      usage,
      input.modelId,
      input.modelProfile,
    ),
  });

  return { text: accumulatedText, usage };
}

function textFromChunk(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') return '';
  const content = (chunk as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (
          part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function accumulateUsageFromChunk(
  chunk: unknown,
  usage: UsageAccumulator,
): void {
  if (!chunk || typeof chunk !== 'object') return;
  const metadata = (chunk as { usage_metadata?: unknown }).usage_metadata;
  if (!metadata || typeof metadata !== 'object') return;
  const input = readNumber(
    (metadata as { input_tokens?: unknown }).input_tokens,
  );
  const output = readNumber(
    (metadata as { output_tokens?: unknown }).output_tokens,
  );
  // usage_metadata on AIMessageChunks is cumulative for a single model turn, so
  // keep the largest seen rather than summing partial deltas.
  if (input > usage.inputTokens) usage.inputTokens = input;
  if (output > usage.outputTokens) usage.outputTokens = output;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizedUsage(
  usage: UsageAccumulator,
  modelId: string | undefined,
): NormalizedModelUsage {
  return {
    ...(modelId ? { model: modelId } : {}),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalBillableInputTokens: usage.inputTokens,
    cacheProvider: 'none',
    cacheStatus: 'unknown',
    at: nowIso(),
  };
}

function contextUsageSnapshot(
  usage: UsageAccumulator,
  modelId: string | undefined,
  profile: ModelProfileSnapshot,
): RuntimeContextUsageSnapshot {
  const maxTokens = profile.maxInputTokens ?? 0;
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const percentage =
    maxTokens > 0 ? Math.min(100, (totalTokens / maxTokens) * 100) : 0;
  return {
    totalTokens,
    maxTokens,
    percentage,
    ...(modelId ? { model: modelId } : {}),
    categories: [],
    apiUsage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    at: nowIso(),
  };
}
