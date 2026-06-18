import type {
  NormalizedCacheProvider,
  NormalizedCacheStatus,
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../../../shared/model-catalog.js';
import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
import { nowIso } from '../../../../shared/time/datetime.js';

// Pure normalizer: turns an async iterable of LangGraph `streamEvents` (v2)
// events into provider-neutral runner output frames. Kept free of any
// network/SDK construction so it is unit-testable against a mocked stream.
//
// Behavior mirrors the Anthropic runner streaming contract:
//   - text token deltas are emitted as intermediate frames
//     { status:'success', result:<delta>, newSessionId } so channels stream;
//   - the SINGLE per-turn terminal frame is NOT emitted here. The normalizer
//     returns the terminal payload (result text, usage, contextUsage) so the
//     caller (runner index) emits exactly one terminal marker per user-visible
//     turn, folding in the continuation/stop decision (R2). This mirrors the
//     Anthropic query-loop, which emits one `result` frame per inner turn that
//     carries usage, contextUsage, and `continuedByFollowup` together.
// usage_metadata (input_tokens/output_tokens) is accumulated across
// AIMessageChunks. Context-window figures come from the runtime model profile,
// never hardcoded.

export interface LangGraphStreamEvent {
  event: string;
  // The runnable name on `on_tool_start`/`on_tool_end` events is the tool name.
  name?: string;
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
  // Prompt-cache provider for the resolved model, derived from the runner's
  // endpoint family on the HOST/runner (openrouter -> 'openrouter-provider',
  // openai -> 'openai'). The normalizer must not import the model catalog
  // (provider boundary), so the cache provider is passed in. When 'none' the
  // lane has no prompt cache and cache tokens are reported as zero/unsupported.
  cacheProvider?: NormalizedCacheProvider;
  emit: (frame: RunnerOutputFrame) => void;
  onFirstEvent?: (eventName: string) => void;
  onFirstVisibleText?: () => void;
  // Called with the tool name when a tool invocation starts. The scheduled-job
  // heartbeat uses this to mark tool activity so a long-running tool (e.g. the
  // shell tool) keeps the lease alive instead of looking idle.
  onToolStart?: (toolName: string) => void;
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  // Prompt-cache read/write tokens, read off the final/cumulative usage chunk.
  // OpenAI/Kimi cache automatically; reads land on
  // prompt_tokens_details.cached_tokens (raw) / input_token_details.cache_read
  // (LangChain). Only OpenRouter sub-models that support explicit cache_control
  // report writes (prompt_tokens_details.cache_write_tokens); OpenAI has none.
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// Terminal payload the caller folds into the single per-turn terminal frame.
export interface NormalizedTurnResult {
  text: string;
  usage: UsageAccumulator;
  // `result` to put on the terminal frame: the accumulated assistant text only
  // when no partial text was streamed (avoids double-rendering), else null.
  terminalResult: string | null;
  terminalUsage: NormalizedModelUsage;
  terminalContextUsage: RuntimeContextUsageSnapshot;
}

export async function normalizeDeepAgentStream(
  input: StreamNormalizerInput,
): Promise<NormalizedTurnResult> {
  const usage: UsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let accumulatedText = '';
  let sawPartialText = false;
  let sawFirstEvent = false;
  let sawFirstVisibleText = false;

  for await (const event of input.events) {
    if (!sawFirstEvent) {
      sawFirstEvent = true;
      input.onFirstEvent?.(event.event);
    }
    if (event.event === 'on_chat_model_stream') {
      const chunk = event.data?.chunk;
      accumulateUsageFromChunk(chunk, usage);
      const delta = textFromChunk(chunk);
      if (delta) {
        if (!sawFirstVisibleText) {
          sawFirstVisibleText = true;
          input.onFirstVisibleText?.();
        }
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
      continue;
    }
    if (event.event === 'on_tool_start' && typeof event.name === 'string') {
      input.onToolStart?.(event.name);
    }
  }

  // The terminal frame is emitted by the caller (runner index) so there is
  // exactly one terminal marker per user-visible turn and it can carry the
  // continuation/stop decision. The normalizer only streams deltas.
  return {
    text: accumulatedText,
    usage,
    terminalResult: sawPartialText ? null : accumulatedText || null,
    terminalUsage: normalizedUsage(usage, input.modelId, input.cacheProvider),
    terminalContextUsage: contextUsageSnapshot(
      usage,
      input.modelId,
      input.modelProfile,
    ),
  };
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
  const input = readNumber(readPath(metadata, 'input_tokens'));
  const output = readNumber(readPath(metadata, 'output_tokens'));
  // usage_metadata on AIMessageChunks is cumulative for a single model turn, so
  // keep the largest seen rather than summing partial deltas.
  if (input > usage.inputTokens) usage.inputTokens = input;
  if (output > usage.outputTokens) usage.outputTokens = output;

  // Cache reads/writes ride on the final/cumulative chunk and are read off BOTH
  // shapes, preferring the raw provider fields when present:
  //   - raw provider usage on response_metadata.usage.prompt_tokens_details.*
  //     ({cached_tokens, cache_write_tokens}). ChatOpenAI surfaces this on its
  //     final empty chunk; the fake OpenRouter gateway also carries it. Writes
  //     are ONLY available here (no LangChain-normalized name exists).
  //   - LangChain's normalized usage_metadata.input_token_details.cache_read /
  //     .cache_creation. ChatOpenRouter only maps cached_tokens -> cache_read,
  //     so reads land here even when the raw usage is absent.
  const rawUsage = readPath(chunk, 'response_metadata.usage');
  // Cache-read field varies by upstream provider, so read the FIRST present:
  //   - prompt_tokens_details.cached_tokens (OpenAI / Groq / xAI / Fireworks /
  //     Cerebras / Gemini / OpenRouter — nested);
  //   - prompt_cache_hit_tokens (DeepSeek — flat, alongside
  //     prompt_cache_miss_tokens);
  //   - cached_tokens (Together — flat);
  //   - the LangChain-normalized usage_metadata.input_token_details.cache_read
  //     fallback.
  const cacheRead = firstFinite(
    readPath(rawUsage, 'prompt_tokens_details.cached_tokens'),
    readPath(rawUsage, 'prompt_cache_hit_tokens'),
    readPath(rawUsage, 'cached_tokens'),
    readPath(metadata, 'input_token_details.cache_read'),
  );
  const cacheWrite = firstFinite(
    readPath(rawUsage, 'prompt_tokens_details.cache_write_tokens'),
    readPath(metadata, 'input_token_details.cache_creation'),
  );
  // Cumulative-per-turn, same as input/output: keep the largest seen.
  if (cacheRead > usage.cacheReadTokens) usage.cacheReadTokens = cacheRead;
  if (cacheWrite > usage.cacheWriteTokens) usage.cacheWriteTokens = cacheWrite;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// First finite number among the candidates (provider raw field preferred over
// the LangChain-normalized one). Returns 0 when none is a finite number.
function firstFinite(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

// Safe dotted-path read over an unknown object graph (mirrors the host
// normalizer's readPath in shared/model-usage.ts).
function readPath(input: unknown, path: string): unknown {
  let cursor = input;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function normalizedUsage(
  usage: UsageAccumulator,
  modelId: string | undefined,
  cacheProvider: NormalizedCacheProvider | undefined,
): NormalizedModelUsage {
  const provider = cacheProvider ?? 'none';
  // A prompt-cache lane (openai/openrouter-provider) supports cache accounting;
  // 'none' means the model has no prompt cache so reads/writes are unsupported.
  const supportsCacheAccounting = provider !== 'none';
  const cacheReadTokens = supportsCacheAccounting ? usage.cacheReadTokens : 0;
  const cacheWriteTokens = supportsCacheAccounting ? usage.cacheWriteTokens : 0;
  return {
    ...(modelId ? { model: modelId } : {}),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // Cache reads are already counted inside input_tokens, so the billable
    // (non-cached) input is input - reads (mirrors the host normalizer).
    totalBillableInputTokens: supportsCacheAccounting
      ? Math.max(0, usage.inputTokens - cacheReadTokens)
      : usage.inputTokens,
    cacheProvider: provider,
    cacheStatus: cacheStatusFor(
      cacheReadTokens,
      cacheWriteTokens,
      supportsCacheAccounting,
    ),
    at: nowIso(),
  };
}

// Cache-status mapping identical to the host normalizer
// (shared/model-usage.ts normalizeCacheStatus): on a supported lane, reads+
// writes -> 'partial', reads -> 'hit', writes -> 'miss', neither -> 'unknown';
// an unsupported lane is always 'unsupported'.
function cacheStatusFor(
  read: number,
  write: number,
  supported: boolean,
): NormalizedCacheStatus {
  if (!supported) return 'unsupported';
  if (read > 0 && write > 0) return 'partial';
  if (read > 0) return 'hit';
  if (write > 0) return 'miss';
  return 'unknown';
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
      cache_creation_input_tokens: usage.cacheWriteTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
    },
    at: nowIso(),
  };
}
