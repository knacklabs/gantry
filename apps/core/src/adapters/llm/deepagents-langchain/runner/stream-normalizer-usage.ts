import type {
  NormalizedCacheProvider,
  NormalizedCacheStatus,
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../../../shared/model-catalog.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import type { ModelProfileSnapshot } from './stream-normalizer.js';

// Usage accounting for the DeepAgents stream normalizer: accumulates
// usage_metadata across AIMessageChunks and shapes the provider-neutral usage
// and context-window figures. Split out of stream-normalizer.ts to keep that
// file inside the architecture file-size budget.

export interface UsageAccumulator {
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

export function accumulateUsageFromChunk(
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

export function normalizedUsage(
  usage: UsageAccumulator,
  modelId: string | undefined,
  cacheProvider: NormalizedCacheProvider | undefined,
  modelProvider: NormalizedModelUsage['provider'],
  modelRoute: NormalizedModelUsage['modelRoute'],
): NormalizedModelUsage {
  const provider = cacheProvider ?? 'none';
  // A prompt-cache lane (openai/openrouter-provider) supports cache accounting;
  // 'none' means the model has no prompt cache so reads/writes are unsupported.
  const supportsCacheAccounting = provider !== 'none';
  const cacheReadTokens = supportsCacheAccounting ? usage.cacheReadTokens : 0;
  const cacheWriteTokens = supportsCacheAccounting ? usage.cacheWriteTokens : 0;
  return {
    ...(modelId ? { model: modelId } : {}),
    ...(modelProvider ? { provider: modelProvider } : {}),
    ...(modelRoute ? { modelRoute } : {}),
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

export function contextUsageSnapshot(
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
